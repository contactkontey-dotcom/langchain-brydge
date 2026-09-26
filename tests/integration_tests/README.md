# Integration tests

These run a real LangChain agent against a running BRYDGE over HTTP. The test
file starts a small books server on `localhost`, which acts as the destination:
the agent's tool writes refunds into it, and BRYDGE reads them back with its
own credential.

The BRYDGE under test needs a workspace with:

- an API key,
- a declared value for the `refund` action,
- a destination for `refund` that reads `http://localhost:<port>/transactions`,
  with the books token as its credential,
- mandates for `agent:lc-honest`, `agent:lc-overpays`, `agent:lc-silent` and
  `agent:lc-self` on `refund`, covering amounts up to 10000.

Because the books run on `localhost`, BRYDGE must run with
`BRYDGE_ALLOW_PRIVATE_DESTINATIONS=1`.

In the BRYDGE repository, `scripts/langchain-fixture.ts` creates such a
workspace in a local database and prints the environment these tests read.
The commands are bash; on Windows, run them in Git Bash:

```bash
# in the BRYDGE repository
BRYDGE_ALLOW_PRIVATE_DESTINATIONS=1 npm run dev
BRYDGE_ALLOW_PRIVATE_DESTINATIONS=1 npx tsx --env-file=.env scripts/langchain-fixture.ts 4599 > /tmp/brydge-int.env

# in this package
set -a; . /tmp/brydge-int.env; set +a
npm run test:int
```

| Variable | |
| --- | --- |
| `BRYDGE_URL` | The BRYDGE under test |
| `BRYDGE_API_KEY` | A key for the prepared workspace |
| `BRYDGE_TEST_BOOKS_PORT` | Where the books server listens |
| `BRYDGE_TEST_BOOKS_TOKEN` | The credential BRYDGE presents to the books |

Without these, the tests are skipped.
