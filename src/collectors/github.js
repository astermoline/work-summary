const PR_SEARCH_QUERY = `
  query SearchPRs($searchQuery: String!, $cursor: String) {
    search(query: $searchQuery, type: ISSUE, first: 50, after: $cursor) {
      issueCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ... on PullRequest {
          number
          title
          body
          url
          state
          isDraft
          createdAt
          updatedAt
          mergedAt
          closedAt
          baseRefName
          headRefName
          author {
            login
          }
          mergedBy {
            login
          }
          repository {
            name
            nameWithOwner
          }
          commits(last: 100) {
            nodes {
              commit {
                oid
                abbreviatedOid
                messageHeadline
                committedDate
                authoredDate
                author {
                  user {
                    login
                  }
                  name
                  email
                }
                committer {
                  user {
                    login
                  }
                  name
                  email
                }
              }
            }
          }
          reviews(last: 30) {
            nodes {
              author {
                login
              }
              state
              submittedAt
              body
            }
          }
          comments(last: 30) {
            nodes {
              author {
                login
              }
              createdAt
              body
            }
          }
        }
      }
    }
  }
`;

/**
 * Extracts Linear ticket keys (e.g., STY-1790, REQS-245) from text.
 * @param {string} text
 * @returns {Array<string>}
 */
function extractLinearTickets(text) {
  if (!text) return [];
  const matches = text.match(/\b(?:STY|REQS)-\d+\b/gi) || [];
  return Array.from(new Set(matches.map(m => m.toUpperCase())));
}

/**
 * Checks whether a commit author/committer matches the configured GitHub user.
 * @param {Object} commitNode GraphQL commit object
 * @param {string} usernameLower Lowercase GitHub username
 * @param {string} [userName] Full display name from env
 * @returns {boolean}
 */
function isCommitByUser(commitNode, usernameLower, userName = '') {
  if (!commitNode) return false;
  const authorLogin = commitNode.author?.user?.login?.toLowerCase();
  const committerLogin = commitNode.committer?.user?.login?.toLowerCase();

  if (authorLogin === usernameLower || committerLogin === usernameLower) {
    return true;
  }

  // Fallback check for secondary login or git config name
  const knownLogins = new Set([usernameLower, 'astermoline', 'nickmoline']);
  if ((authorLogin && knownLogins.has(authorLogin)) || (committerLogin && knownLogins.has(committerLogin))) {
    return true;
  }

  if (userName) {
    const authorName = (commitNode.author?.name || '').toLowerCase();
    if (authorName && (authorName === userName.toLowerCase() || authorName.includes('aster') || authorName.includes('moline'))) {
      return true;
    }
  }

  return false;
}

/**
 * Collector for GitHub Pull Request, Commit, Review, and Merge activity
 */
export default {
  name: 'github',
  displayName: 'GitHub',
  enabled: true,
  async collect(sinceDate, nowDate, env) {
    const token = env.githubToken;
    const username = env.githubUsername;
    const org = env.githubOrg || process.env.GITHUB_ORG || 'Storyllp';

    if (!token || !username) {
      console.log('[-] GitHub is not configured (missing GITHUB_TOKEN or GITHUB_USERNAME). Skipping...');
      return null;
    }

    try {
      const usernameLower = username.toLowerCase();
      const sinceTime = new Date(sinceDate).getTime();
      const untilTime = new Date(nowDate).getTime();

      const inRange = (isoStr) => {
        if (!isoStr) return false;
        const t = new Date(isoStr).getTime();
        return t >= sinceTime && t <= untilTime;
      };

      const orgFilter = org ? ` org:${org}` : '';

      // Search queries (scoped to the configured GitHub organization when set):
      // 1. PRs involving the user
      // 2. PRs reviewed by the user
      // 3. All PRs updated in the organization during the window (catches coworker PRs where the user pushed commits or merged without commenting)
      const queries = [
        { q: `is:pr${orgFilter} involves:${username} updated:${sinceDate}..${nowDate}`, directMatch: true },
        { q: `is:pr${orgFilter} reviewed-by:${username} updated:${sinceDate}..${nowDate}`, directMatch: true },
      ];

      if (org) {
        queries.push({
          q: `is:pr org:${org} updated:${sinceDate}..${nowDate}`,
          directMatch: false,
        });
      }

      const prMap = new Map();

      for (const { q, directMatch } of queries) {
        let hasNextPage = true;
        let cursor = null;

        while (hasNextPage) {
          const response = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': 'work-summary-app',
            },
            body: JSON.stringify({
              query: PR_SEARCH_QUERY,
              variables: { searchQuery: q, cursor },
            }),
          });

          if (!response.ok) {
            throw new Error(`GitHub GraphQL API returned status ${response.status}: ${await response.text()}`);
          }

          const resJson = await response.json();
          if (resJson.errors && resJson.errors.length > 0) {
            throw new Error(`GitHub GraphQL Errors: ${resJson.errors.map(e => e.message).join('; ')}`);
          }

          const searchData = resJson.data?.search;
          const nodes = searchData?.nodes || [];

          for (const pr of nodes) {
            if (!pr || !pr.repository || !pr.number) continue;
            const key = `${pr.repository.nameWithOwner}#${pr.number}`;
            const existing = prMap.get(key);
            if (!existing) {
              prMap.set(key, { pr, directMatch });
            } else if (directMatch && !existing.directMatch) {
              existing.directMatch = true;
            }
          }

          hasNextPage = Boolean(searchData?.pageInfo?.hasNextPage);
          cursor = searchData?.pageInfo?.endCursor || null;
        }
      }

      const results = [];

      for (const { pr, directMatch } of prMap.values()) {
        if (!inRange(pr.updatedAt)) continue;

        const fullRepo = pr.repository.nameWithOwner || 'Unknown Repository';
        const repoShortName = pr.repository.name || (fullRepo.includes('/') ? fullRepo.split('/')[1] : fullRepo);
        const author = pr.author?.login || 'unknown';
        const isAuthor = author.toLowerCase() === usernameLower;

        const isCreatedInTimeframe = inRange(pr.createdAt);
        const isMerged = pr.state === 'MERGED' || Boolean(pr.mergedAt);
        const isMergedInTimeframe = isMerged && inRange(pr.mergedAt);
        const isClosedInTimeframe = pr.state === 'CLOSED' && !isMerged && inRange(pr.closedAt);
        const mergedBy = pr.mergedBy?.login || null;
        const mergedByMe = isMergedInTimeframe && mergedBy?.toLowerCase() === usernameLower;

        const isLivePush = pr.baseRefName === 'main' && (pr.headRefName === 'dev' || /live push/i.test(pr.title || ''));

        // Identify commits pushed/authored by the user on this PR within the timeframe
        // (Skip individual commit listing on Live Push release PRs from dev -> main so merged dev commits aren't misattributed)
        const userCommits = [];
        if (!isLivePush) {
          for (const n of pr.commits?.nodes || []) {
            const c = n?.commit;
            if (!c) continue;
            const commitTimeStr = c.committedDate || c.authoredDate;
            if (inRange(commitTimeStr) && isCommitByUser(c, usernameLower, env.userName)) {
              // Filter out generic "Merge branch 'dev'" commits if there are more descriptive commits, or keep all with headlines
              userCommits.push({
                sha: c.abbreviatedOid || (c.oid ? c.oid.slice(0, 7) : ''),
                message: c.messageHeadline || '',
                timestamp: commitTimeStr,
              });
            }
          }
        }

        // Identify reviews submitted by the user in this timeframe
        const userReviews = (pr.reviews?.nodes || [])
          .filter(r => r?.author?.login?.toLowerCase() === usernameLower && inRange(r.submittedAt))
          .map(r => ({
            state: r.state,
            submittedAt: r.submittedAt,
            body: (r.body || '').trim(),
          }));

        // Identify PR comments posted by the user in this timeframe
        const userComments = (pr.comments?.nodes || [])
          .filter(c => c?.author?.login?.toLowerCase() === usernameLower && inRange(c.createdAt))
          .map(c => ({
            createdAt: c.createdAt,
            body: (c.body || '').trim(),
          }));

        const hasUserActionInTimeframe =
          (isAuthor && isCreatedInTimeframe) ||
          mergedByMe ||
          (isAuthor && isMergedInTimeframe) ||
          (isAuthor && isClosedInTimeframe) ||
          userCommits.length > 0 ||
          userReviews.length > 0 ||
          userComments.length > 0;

        // If the PR came from the broad org search, require explicit user involvement
        if (!directMatch && !isAuthor && !hasUserActionInTimeframe) {
          continue;
        }

        // Exclude PRs that were already merged/closed before this window and have no user actions in this window
        if ((isMerged && !isMergedInTimeframe) || (pr.state === 'CLOSED' && !isClosedInTimeframe)) {
          if (userCommits.length === 0 && userReviews.length === 0 && userComments.length === 0) {
            continue;
          }
        }

        // Build a human-readable status label
        let statusLabel = pr.state;
        if (isMerged) {
          statusLabel = `MERGED into ${pr.baseRefName}`;
        } else if (pr.state === 'OPEN') {
          statusLabel = pr.isDraft ? `OPEN (Draft) targeting ${pr.baseRefName}` : `OPEN targeting ${pr.baseRefName}`;
        } else if (pr.state === 'CLOSED') {
          statusLabel = `CLOSED (unmerged) targeting ${pr.baseRefName}`;
        }

        const referencedTickets = extractLinearTickets(`${pr.title || ''} ${pr.headRefName || ''} ${pr.body || ''}`);

        results.push({
          title: pr.title || '(No Title)',
          url: pr.url || '',
          number: pr.number,
          state: isMerged ? 'merged' : (pr.state || 'unknown').toLowerCase(),
          statusLabel,
          isDraft: Boolean(pr.isDraft),
          baseRefName: pr.baseRefName || '',
          headRefName: pr.headRefName || '',
          isLivePush,
          repository: fullRepo,
          repoShortName,
          createdAt: pr.createdAt,
          updatedAt: pr.updatedAt,
          mergedAt: pr.mergedAt || null,
          isCreatedInTimeframe,
          isMergedInTimeframe,
          author,
          isAuthor,
          mergedBy,
          mergedByMe,
          userCommits,
          userReviews,
          userComments,
          referencedTickets,
        });
      }

      // Sort chronologically by updatedAt
      results.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());

      return results;
    } catch (error) {
      console.error('[!] Error collecting from GitHub:', error.message);
      return { error: error.message };
    }
  },
};
