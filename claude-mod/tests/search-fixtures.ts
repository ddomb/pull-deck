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
      "url": "https://github.com/acme/above/pull/11780"
    },
    {
      "id": "pr-b",
      "scope": "reviewing",
      "number": 10637,
      "repo": "acme/above",
      "headRefName": "noa/ABV-9001-cache",
      "title": "Cache the viewer",
      "url": "https://github.com/acme/above/pull/10637"
    },
    {
      "id": "pr-c",
      "scope": "assigned",
      "number": 4120,
      "repo": "acme/docs",
      "headRefName": "fix/ABV-8800-typo",
      "title": "Fix a typo",
      "url": "https://github.com/acme/docs/pull/4120"
    }
  ],
  "cases": [
    { "query": "ABV-10637", "expect": ["pr-a"], "why": "ticket, canonical case" },
    { "query": "abv-10637", "expect": ["pr-a"], "why": "ticket, lower case" },
    { "query": "Abv-10637", "expect": ["pr-a"], "why": "ticket, mixed case" },
    { "query": "abv10637", "expect": ["pr-a"], "why": "ticket without the dash" },
    { "query": "11780", "expect": ["pr-a"], "why": "bare PR number" },
    { "query": "#11780", "expect": ["pr-a"], "why": "PR number with #" },
    { "query": "above/11780", "expect": ["pr-a"], "why": "repo/number" },
    { "query": "acme/above#11780", "expect": ["pr-a"], "why": "owner/repo#number" },
    { "query": "docs/11780", "expect": [], "why": "right number, wrong repo" },
    {
      "query": "10637",
      "expect": ["pr-b"],
      "why": "number collides with ticket ABV-10637: digits mean PR number"
    },
    { "query": "ABV-99999", "expect": [], "why": "ticket not in snapshot" },
    { "query": "99999", "expect": [], "why": "PR number not in snapshot" }
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
      "url": "https://github.com/acme/above/pull/11780"
    },
    {
      "id": "pr-b",
      "scope": "reviewing",
      "number": 10637,
      "repo": "acme/above",
      "headRefName": "noa/ABV-9001-cache",
      "title": "Cache the viewer",
      "url": "https://github.com/acme/above/pull/10637"
    },
    {
      "id": "pr-c",
      "scope": "assigned",
      "number": 4120,
      "repo": "acme/docs",
      "headRefName": "fix/ABV-8800-typo",
      "title": "Fix a typo",
      "url": "https://github.com/acme/docs/pull/4120"
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
        "status": "one",
        "prIds": ["pr-b"],
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
    }
  ]
}
