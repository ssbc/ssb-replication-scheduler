<!--
SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros

SPDX-License-Identifier: CC0-1.0
-->

# ssb-replication-scheduler

*Triggers replication of feeds identified as friendly in the social graph.*

Depends on ssb-friends APIs, and calls ssb-ebt APIs.

## Installation

**Prerequisites:**

- Requires **Node.js 10** or higher
- Requires **ssb-db** or **ssb-db2**
- Requires **ssb-friends** version **5.0** or higher
- Requires **ssb-ebt** version **7.0** or higher

```
npm install --save ssb-replication-scheduler
```

Add this secret-stack plugin like this:

```diff
 const SecretStack = require('secret-stack')
 const caps = require('ssb-caps')

 const createSsbServer = SecretStack({ caps })
     .use(require('ssb-master'))
     .use(require('ssb-db2'))
     .use(require('ssb-ebt'))
     .use(require('ssb-friends'))
+    .use(require('ssb-replication-scheduler'))
     .use(require('ssb-conn'))
     // ...
```

## Usage

There are no APIs, and nothing else you need to do. As soon as the SSB peer is
initialized, `ssb-replication-scheduler` will automatically query the social
graph, and either request replication or stop replication, depending whether the
feed is friendly or blocked.

**Opinions embedded in the scheduler:**

- Replication is enabled for:
  - The main feed, `ssb.id`, because this allows you to recover your feed
  - Any friendly feed at a distance of at most `config.friends.hops`
    - Includes your friends (if `config.friends.hops >= 1`)
    - Includes friends of friends (if `config.friends.hops >= 2`)
    - Includes friends of friends of friends (if `config.friends.hops >= 3`)
    - And so forth
- Replication is strictly disabled for:
  - Any feed you explicitly block

## License

LGPL-3.0
