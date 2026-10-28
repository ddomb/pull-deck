// The shared query table (test/fixtures/search-cases.json) and the JS bridge's real replies to it
// (test/fixtures/search-replies.json), as code. The mod test runtime reads no file outside the plugin, and no .json.
// Regenerate from the repo root after the JSON changes:
//   node -e 'const f=require("fs"),p="claude-mod/tests/search-fixtures.ts",r=n=>f.readFileSync(`test/fixtures/search-${n}.json`,"utf8").trim(),t=f.readFileSync(p,"utf8");f.writeFileSync(p,t.slice(0,t.indexOf("\nexport const cases")+1)+`export const cases = ${r("cases")}\n\nexport const replies = ${r("replies")}\n`)'
export const cases = {
  "pullRequests": [
    {
      "id": "pr-a",
      "scope": "mine",
      "number": 11780,
      "repo": "acme/above",
      "headRefName": "ddomb/ABV-10637-search-box",
      "title": "Add a search box",
      "url": "https://github.com/acme/above/pull/11780",
      "updatedAt": "2026-10-20T10:00:00Z"
    },
    {
      "id": "pr-b",
      "scope": "reviewing",
      "number": 10637,
      "repo": "acme/above",
      "headRefName": "noa/ABV-9001-cache",
      "title": "Cache the viewer",
      "url": "https://github.com/acme/above/pull/10637",
      "updatedAt": "2026-10-19T10:00:00Z"
    },
    {
      "id": "pr-c",
      "scope": "assigned",
      "number": 4120,
      "repo": "acme/docs",
      "headRefName": "fix/ABV-8800-typo",
      "title": "Fix a typo",
      "url": "https://github.com/acme/docs/pull/4120",
      "updatedAt": "2026-10-18T10:00:00Z"
    },
    {
      "id": "pr-d",
      "scope": "mine",
      "number": 11212,
      "repo": "acme/above",
      "headRefName": "ddomb/ABV-7805-pull-deck-search",
      "title": "Pull Deck search",
      "url": "https://github.com/acme/above/pull/11212",
      "updatedAt": "2026-10-27T10:00:00Z"
    },
    {
      "id": "pr-e",
      "scope": "reviewing",
      "number": 11210,
      "repo": "acme/above",
      "headRefName": "noa/ABV-7806-session",
      "title": "Refresh the session cache",
      "url": "https://github.com/acme/above/pull/11210",
      "updatedAt": "2026-10-26T10:00:00Z"
    },
    {
      "id": "pr-f",
      "scope": "assigned",
      "number": 7805,
      "repo": "acme/docs",
      "headRefName": "fix/DOC-12-readme",
      "title": "Readme tweaks",
      "url": "https://github.com/acme/docs/pull/7805",
      "updatedAt": "2026-10-25T10:00:00Z"
    }
  ],
  "cases": [
    {
      "query": "ABV-10637",
      "expect": ["pr-a"],
      "why": "ticket, canonical case"
    },
    {
      "query": "abv-10637",
      "expect": ["pr-a"],
      "why": "ticket, lower case"
    },
    {
      "query": "Abv-10637",
      "expect": ["pr-a"],
      "why": "ticket, mixed case"
    },
    {
      "query": "abv10637",
      "expect": ["pr-a"],
      "why": "ticket without the dash"
    },
    {
      "query": "11780",
      "expect": ["pr-a"],
      "why": "bare PR number"
    },
    {
      "query": "#11780",
      "expect": ["pr-a"],
      "why": "PR number with #"
    },
    {
      "query": "above/11780",
      "expect": ["pr-a"],
      "why": "repo/number"
    },
    {
      "query": "acme/above#11780",
      "expect": ["pr-a"],
      "why": "owner/repo#number"
    },
    {
      "query": "docs/11780",
      "expect": [],
      "why": "right number, wrong repo"
    },
    {
      "query": "10637",
      "expect": ["pr-b", "pr-a"],
      "why": "number collides with ticket ABV-10637: the PR number ranks first, the ticket follows"
    },
    {
      "query": "ABV-99999",
      "expect": [],
      "why": "ticket not in snapshot"
    },
    {
      "query": "99999",
      "expect": [],
      "why": "PR number not in snapshot"
    },
    {
      "query": "7805",
      "expect": ["pr-f", "pr-d"],
      "why": "bare ticket number: PR #7805 first, then the ABV-7805 branch"
    },
    {
      "query": "1121",
      "expect": ["pr-d", "pr-e"],
      "why": "half-typed PR number: prefix of 11212 and 11210, most recent first"
    },
    {
      "query": "11212",
      "expect": ["pr-d"],
      "why": "full PR number"
    },
    {
      "query": "780",
      "expect": ["pr-f", "pr-d", "pr-e"],
      "why": "half-typed number: PR number prefix, then ticket number prefixes"
    },
    {
      "query": "ABV-78",
      "expect": ["pr-d", "pr-e"],
      "why": "half-typed ticket"
    },
    {
      "query": "abv 7805",
      "expect": ["pr-d"],
      "why": "space instead of dash"
    },
    {
      "query": "ABV_7805",
      "expect": ["pr-d"],
      "why": "underscore instead of dash"
    },
    {
      "query": "abv7805",
      "expect": ["pr-d"],
      "why": "no separator"
    },
    {
      "query": "  ABV-7805 ",
      "expect": ["pr-d"],
      "why": "pasted with whitespace"
    },
    {
      "query": "https://github.com/acme/above/pull/11212/files",
      "expect": ["pr-d"],
      "why": "pasted GitHub PR URL"
    },
    {
      "query": "https://linear.app/acme/issue/ABV-7805/pull-deck-search",
      "expect": ["pr-d"],
      "why": "pasted Linear issue URL"
    },
    {
      "query": "PR 11212",
      "expect": ["pr-d"],
      "why": "PR word before the number"
    },
    {
      "query": "#1121",
      "expect": ["pr-d", "pr-e"],
      "why": "hash and half-typed number"
    },
    {
      "query": "above/1121",
      "expect": ["pr-d", "pr-e"],
      "why": "repo and half-typed number"
    },
    {
      "query": "docs/1121",
      "expect": [],
      "why": "half-typed number in a repo that has none"
    },
    {
      "query": "search",
      "expect": ["pr-d", "pr-a"],
      "why": "a word from the branch or title, most recent first"
    },
    {
      "query": "deck search",
      "expect": ["pr-d"],
      "why": "several words in any order"
    },
    {
      "query": "ABV-7807",
      "expect": [],
      "why": "a ticket that is not in the snapshot, not a near miss"
    },
    {
      "query": "1",
      "expect": ["pr-d", "pr-e", "pr-a", "pr-b", "pr-f"],
      "why": "one digit: PR numbers that start with it, most recent first, then ticket numbers (DOC-12)"
    },
    {
      "query": "#7805",
      "expect": ["pr-f"],
      "why": "a hash means a PR number, never a ticket number"
    },
    {
      "query": "ABV-7805.",
      "expect": ["pr-d"],
      "why": "pasted from a sentence with its full stop"
    },
    {
      "query": "SEARCH deck",
      "expect": ["pr-d"],
      "why": "words in any case and order"
    },
    {
      "query": "🔥",
      "expect": [],
      "why": "paste junk finds nothing"
    }
  ]
}

export const replies = {
  "pullRequests": [
    {
      "id": "pr-a",
      "scope": "mine",
      "number": 11780,
      "repo": "acme/above",
      "headRefName": "ddomb/ABV-10637-search-box",
      "title": "Add a search box",
      "url": "https://github.com/acme/above/pull/11780",
      "updatedAt": "2026-10-20T10:00:00Z"
    },
    {
      "id": "pr-b",
      "scope": "reviewing",
      "number": 10637,
      "repo": "acme/above",
      "headRefName": "noa/ABV-9001-cache",
      "title": "Cache the viewer",
      "url": "https://github.com/acme/above/pull/10637",
      "updatedAt": "2026-10-19T10:00:00Z"
    },
    {
      "id": "pr-c",
      "scope": "assigned",
      "number": 4120,
      "repo": "acme/docs",
      "headRefName": "fix/ABV-8800-typo",
      "title": "Fix a typo",
      "url": "https://github.com/acme/docs/pull/4120",
      "updatedAt": "2026-10-18T10:00:00Z"
    },
    {
      "id": "pr-d",
      "scope": "mine",
      "number": 11212,
      "repo": "acme/above",
      "headRefName": "ddomb/ABV-7805-pull-deck-search",
      "title": "Pull Deck search",
      "url": "https://github.com/acme/above/pull/11212",
      "updatedAt": "2026-10-27T10:00:00Z"
    },
    {
      "id": "pr-e",
      "scope": "reviewing",
      "number": 11210,
      "repo": "acme/above",
      "headRefName": "noa/ABV-7806-session",
      "title": "Refresh the session cache",
      "url": "https://github.com/acme/above/pull/11210",
      "updatedAt": "2026-10-26T10:00:00Z"
    },
    {
      "id": "pr-f",
      "scope": "assigned",
      "number": 7805,
      "repo": "acme/docs",
      "headRefName": "fix/DOC-12-readme",
      "title": "Readme tweaks",
      "url": "https://github.com/acme/docs/pull/7805",
      "updatedAt": "2026-10-25T10:00:00Z"
    }
  ],
  "replies": [
    {
      "query": "ABV-10637",
      "data": {
        "status": "one",
        "prIds": ["pr-a"],
        "stale": false
      }
    },
    {
      "query": "abv-10637",
      "data": {
        "status": "one",
        "prIds": ["pr-a"],
        "stale": false
      }
    },
    {
      "query": "Abv-10637",
      "data": {
        "status": "one",
        "prIds": ["pr-a"],
        "stale": false
      }
    },
    {
      "query": "abv10637",
      "data": {
        "status": "one",
        "prIds": ["pr-a"],
        "stale": false
      }
    },
    {
      "query": "11780",
      "data": {
        "status": "one",
        "prIds": ["pr-a"],
        "stale": false
      }
    },
    {
      "query": "#11780",
      "data": {
        "status": "one",
        "prIds": ["pr-a"],
        "stale": false
      }
    },
    {
      "query": "above/11780",
      "data": {
        "status": "one",
        "prIds": ["pr-a"],
        "stale": false
      }
    },
    {
      "query": "acme/above#11780",
      "data": {
        "status": "one",
        "prIds": ["pr-a"],
        "stale": false
      }
    },
    {
      "query": "docs/11780",
      "data": {
        "status": "none",
        "prIds": [],
        "stale": false
      }
    },
    {
      "query": "10637",
      "data": {
        "status": "many",
        "prIds": ["pr-b", "pr-a"],
        "stale": false
      }
    },
    {
      "query": "ABV-99999",
      "data": {
        "status": "none",
        "prIds": [],
        "stale": false
      }
    },
    {
      "query": "99999",
      "data": {
        "status": "none",
        "prIds": [],
        "stale": false
      }
    },
    {
      "query": "7805",
      "data": {
        "status": "many",
        "prIds": ["pr-f", "pr-d"],
        "stale": false
      }
    },
    {
      "query": "1121",
      "data": {
        "status": "many",
        "prIds": ["pr-d", "pr-e"],
        "stale": false
      }
    },
    {
      "query": "11212",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "780",
      "data": {
        "status": "many",
        "prIds": ["pr-f", "pr-d", "pr-e"],
        "stale": false
      }
    },
    {
      "query": "ABV-78",
      "data": {
        "status": "many",
        "prIds": ["pr-d", "pr-e"],
        "stale": false
      }
    },
    {
      "query": "abv 7805",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "ABV_7805",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "abv7805",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "  ABV-7805 ",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "https://github.com/acme/above/pull/11212/files",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "https://linear.app/acme/issue/ABV-7805/pull-deck-search",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "PR 11212",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "#1121",
      "data": {
        "status": "many",
        "prIds": ["pr-d", "pr-e"],
        "stale": false
      }
    },
    {
      "query": "above/1121",
      "data": {
        "status": "many",
        "prIds": ["pr-d", "pr-e"],
        "stale": false
      }
    },
    {
      "query": "docs/1121",
      "data": {
        "status": "none",
        "prIds": [],
        "stale": false
      }
    },
    {
      "query": "search",
      "data": {
        "status": "many",
        "prIds": ["pr-d", "pr-a"],
        "stale": false
      }
    },
    {
      "query": "deck search",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "ABV-7807",
      "data": {
        "status": "none",
        "prIds": [],
        "stale": false
      }
    },
    {
      "query": "1",
      "data": {
        "status": "many",
        "prIds": ["pr-d", "pr-e", "pr-a", "pr-b", "pr-f"],
        "stale": false
      }
    },
    {
      "query": "#7805",
      "data": {
        "status": "one",
        "prIds": ["pr-f"],
        "stale": false
      }
    },
    {
      "query": "ABV-7805.",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "SEARCH deck",
      "data": {
        "status": "one",
        "prIds": ["pr-d"],
        "stale": false
      }
    },
    {
      "query": "🔥",
      "data": {
        "status": "none",
        "prIds": [],
        "stale": false
      }
    }
  ]
}
