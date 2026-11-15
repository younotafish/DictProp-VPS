# Code the client and the server both run

Each module here is pure and has no import statements at all, so the client bundle, the server and the
plain-node offline scripts can all load it as it is:

- server code: `import { x } from './shared/x.js'` (relative depth as needed)
- client code: `import { x } from '../server/src/shared/x'`
- offline scripts: `import { x } from '../../server/src/shared/x.ts'`

The client imports only from this folder at runtime; for anything else in `server/src` it uses `import type` or
`export type`, which the bundler erases. A contract that needs a dependency keeps two implementations and a
behavioral parity test instead. The Docker client build copies this folder alone, before it builds.
`test/contracts/shared-contracts.test.ts` enforces all three: no imports here, no runtime client imports from
elsewhere in `server/src`, and the Dockerfile's copy ahead of the client build.
