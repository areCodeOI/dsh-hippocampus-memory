// Cross-platform test entry: Windows cmd.exe does not expand `test/*.test.mjs`,
// and the Node test runner's directory mode differs across versions. Importing
// the suites explicitly keeps `npm test` identical on Linux, macOS and Windows.
import './auth.test.mjs'
import './auto-recall.test.mjs'
import './dsh-go.test.mjs'
import './embeddings.test.mjs'
import './http-v2.test.mjs'
import './http.test.mjs'
import './jobs.test.mjs'
import './mcp.test.mjs'
import './plugin.test.mjs'
import './scoring.test.mjs'
import './storage.test.mjs'
import './security.test.mjs'
import './store.test.mjs'
