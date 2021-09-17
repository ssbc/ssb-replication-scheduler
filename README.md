<!--
SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros

SPDX-License-Identifier: CC0-1.0
-->

# ssb-replication-scheduler

_Triggers replication of feeds identified as friendly in the social graph._

Depends on ssb-friends APIs, and calls ssb-ebt APIs.

## Installation

**Prerequisites:**

- Requires **Node.js 10** or higher
- Requires **ssb-db** or **ssb-db2**
- Requires [**ssb-friends**](https://github.com/ssbc/ssb-friends) version **5.0** or higher
- Requires [**ssb-ebt**](https://github.com/ssbc/ssb-ebt) version **7.0** or higher

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

Typically there is nothing you need to do after installing this plugin. As soon
as the SSB peer is initialized, `ssb-replication-scheduler` will automatically
query the social graph, and either request replication or stop replication,
depending whether the feed is friendly or blocked.

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

## Configuration

Some parameters and opinions can be configured by the user or by application
code through the conventional [ssb-config](https://github.com/ssbc/ssb-config)
object. The possible options are listed below:

```js
{
  replicationScheduler: {
    /**
     * If `partialReplication` is an object, it tells the replication scheduler
     * to perform partial replication, whenever remote feeds support it. If
     * `partialReplication` is `null` (which it is, by default), then all
     * friendly feeds will be requested in full.
     *
     * Read below more about this configuration.
     */
    partialReplication: null,
  }
}
```

### Configuring partial replication

The `config.replicationScheduler.partialReplication` object describes the tree
of meta feeds that we are interested in replicating, for each hops level. For
each hops level we have a certain _template_ to describe how replication should
work at that level. Notice that this configuration cannot specify **who** we
replicate (that's the job of ssb-friends and your chosen `hops`, see the _Usage_
section above), this configuration just specifies **how** should we replicate a
friendly peer, in other words, the level of granularity for those peers.

#### Template per hops

The high-level overview of the `partialReplication` configuration is:

```js
replicationScheduler: {
  partialReplication: {
    0: TEMPLATE_FOR_HOPS_0,
    1: TEMPLATE_FOR_HOPS_1,
    2: TEMPLATE_FOR_HOPS_2_AND_ABOVE,
  }
}
```

Soon we'll show how those `TEMPLATE_FOR_HOPS` work, but for now notice that the
highest number will handle all the hops beyond that number, e.g. notice how `2`
is the highest number and it means that `TEMPLATE_FOR_HOPS_2_AND_ABOVE`
configures how to replicate peers at hops 2 or 3 or 4 or higher. There's nothing
special about the number 2, it could also have been this:

```js
replicationScheduler: {
  partialReplication: {
    0: TEMPLATE_FOR_HOPS_0,
    1: TEMPLATE_FOR_HOPS_1_AND_ABOVE,
  }
}
```

Or even this (which means we use the same template for all peers, regardless of
their hops distance):

```js
replicationScheduler: {
  partialReplication: {
    0: TEMPLATE_FOR_HOPS_0_AND_ABOVE,
  }
}
```

Or even fractional numbers:

```js
replicationScheduler: {
  partialReplication: {
    0: TEMPLATE_FOR_HOPS_0,
    0.5: TEMPLATE_FOR_HOPS_HALF,
    1: TEMPLATE_FOR_HOPS_1_AND_ABOVE,
  }
}
```

#### Template structure

A **Template** is JSON which describes how should we do partial replication. If
the template is `null` or a falsy value, then it means that for that hops level
we don't do partial replication and we **will** do **full** replication (which
means pre-2022 SSB replication of the peer's `main` feed).

When the template is a JSON tree of objects and arrays, where the root of the
tree is always the _root meta feed_. The template describes which **keys** in
the metafeeds and subfeeds must match exactly the **values** given. So that if
we write `feedpurposes: 'indexes'`, it means we are interested in matching the
metafeed that has the field `feedpurposes` exactly matching the value "indexes".
All specified fields must match, but omitted fields are allowed to be any value.

The field `subfeeds` is not matching an actual field, instead, it is assumes we
are dealing with a meta feed and this is describing its subfeeds that we would
like to replicate.

#### Special variables

Some keys and some values are special, in the sense that they are not taken
literally, but are going to be substituted by other context-relative values.
These special variables are always prefixed with **`$`**.

- Special keys
  - `$format`
- Special values
  - `$main`
  - `$root`

The field _key_ `$format` refers to [ssb-ebt](https://github.com/ssbc/ssb-ebt)
"replication formats" and can be included in a template to specify which
replication format to use in ssb-ebt. The value of this field should be the
format's name as a string.

If the value of a field, e.g. in ssb-ql-0 queries, are the special strings
`"$main"` or `"$root"`, then they respectively refer to the IDs of the _main
feed_ and of the _root meta feed_.

#### Example

In the example below, we set up partial replication with the meaning:

- For hops 0 (that is, "yourself"), replicate some app feeds and all index feeds
- For hops 1 (direct friends), replicate only some index feeds
- For hops 2 and beyond, replicate only about index feed

```js
partialReplication: {
  0: {
    subfeeds: [
      { feedpurpose: 'coolgame' },
      { feedpurpose: 'git-ssb' },
      {
        feedpurpose: 'indexes',
        subfeeds: [
          {
            feedpurpose: 'index',
            $format: 'indexed',
          },
        ],
      },
    ],
  },

  1: {
    subfeeds: [
      {
        feedpurpose: 'indexes',
        subfeeds: [
          {
            feedpurpose: 'index',
            metadata: {
              querylang: 'ssb-ql-0',
              query: { author: '$main', type: null, private: true },
            },
            $format: 'indexed',
          },
          {
            feedpurpose: 'index',
            metadata: {
              querylang: 'ssb-ql-0',
              query: { author: '$main', type: 'post', private: false },
            },
            $format: 'indexed',
          },
          {
            feedpurpose: 'index',
            metadata: {
              querylang: 'ssb-ql-0',
              query: { author: '$main', type: 'vote', private: false },
            },
            $format: 'indexed',
          },
          {
            feedpurpose: 'index',
            metadata: {
              querylang: 'ssb-ql-0',
              query: { author: '$main', type: 'about', private: false },
            },
            $format: 'indexed',
          },
          {
            feedpurpose: 'index',
            metadata: {
              querylang: 'ssb-ql-0',
              query: { author: '$main', type: 'contact', private: false },
            },
            $format: 'indexed',
          },
        ],
      },
    ],
  },

  2: {
    subfeeds: [
      {
        feedpurpose: 'indexes',
        subfeeds: [
          {
            feedpurpose: 'index',
            metadata: {
              querylang: 'ssb-ql-0',
              query: { author: '$main', type: 'about', private: false },
            },
            $format: 'indexed',
          },
          {
            feedpurpose: 'index',
            metadata: {
              querylang: 'ssb-ql-0',
              query: { author: '$main', type: 'contact', private: false },
            },
            $format: 'indexed',
          },
        ],
      },
    ],
  },
}
```

## muxrpc APIs

### `ssb.replicationScheduler.reconfigure(config) => void`

At any point during the execution of your program, you can reconfigure the
replication rules using this API. The configuration object passed to this API
has the same shape as `config.replicationScheduler` (see above) has.

## License

LGPL-3.0
