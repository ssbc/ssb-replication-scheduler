// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: Unlicense

const tape = require('tape')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const caps = require('ssb-caps')
const pull = require('pull-stream')
const SecretStack = require('secret-stack')
const pify = require('promisify-4loc')
const {
  where,
  and,
  type,
  live,
  toPullStream,
  author,
  authorIsBendyButtV1,
  count,
  toPromise,
} = require('ssb-db2/operators')
const sleep = require('util').promisify(setTimeout)
const u = require('../misc/util')

const createSsbServer = SecretStack({ caps })
  .use(require('ssb-db2'))
  .use(require('ssb-db2/compat/ebt'))
  .use(require('ssb-bendy-butt'))
  .use(require('ssb-conn'))
  .use(require('ssb-ebt'))
  .use(require('ssb-friends'))
  .use(require('ssb-meta-feeds'))
  .use(require('ssb-subset-rpc'))
  .use(require('ssb-index-feeds'))
  .use(require('../..'))

const CONNECTION_TIMEOUT = 1e3
const INACTIVITY_TIMEOUT = 60e3
const REPLICATION_TIMEOUT = 4e3
const INDEX_WRITING_TIMEOUT = 3e3

const aliceKeys = u.keysFor('alice')
const bobKeys = u.keysFor('bob')
const carolKeys = u.keysFor('carol')
const davidKeys = u.keysFor('david')
const aliceMFSeed = Buffer.from(
  '00000000000000000000000000000000000000000000000000000000000a71ce',
  'hex'
)
const bobMFSeed = Buffer.from(
  '0000000000000000000000000000000000000000000000000000000000000b0b',
  'hex'
)

let alice
let bob
let david

tape('setup', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'))
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'))
  rimraf.sync(path.join(os.tmpdir(), 'server-carol'))
  rimraf.sync(path.join(os.tmpdir(), 'server-david'))

  alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    metafeeds: {
      seed: aliceMFSeed, // static seed for deterministic tests
    },
    indexFeeds: {
      autostart: [
        { type: 'post', private: false },
        { type: 'contact', private: false },
      ],
    },
    timeout: CONNECTION_TIMEOUT,
    timers: { inactivity: INACTIVITY_TIMEOUT },
  })

  bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    metafeeds: {
      seed: bobMFSeed, // static seed for deterministic tests
    },
    timers: { inactivity: INACTIVITY_TIMEOUT },
    timeout: CONNECTION_TIMEOUT,
  })

  t.pass('started both peers')
  t.pass('alice is ' + alice.id)
  t.pass('bob is ' + bob.id)

  // Wait for all bots to be ready
  await sleep(500)

  await Promise.all([
    // All peers publish a post
    pify(alice.db.publish)({ type: 'post', text: 'My name is Alice' }),
    pify(bob.db.publish)({ type: 'post', text: 'My name is Bob' }),

    // alice and bob follow each other
    pify(alice.db.publish)(u.follow(bob.id)),
    pify(bob.db.publish)(u.follow(alice.id)),
  ])
  t.pass('published all the messages')

  await new Promise((resolve, reject) => {
    pull(
      alice.db.query(
        where(type('metafeed/index')),
        live({ old: true }),
        toPullStream()
      ),
      pull.take(2),
      pull.collect((err) => {
        if (err) reject(err)
        else resolve()
      })
    )
  })
  t.pass('waited for Alice to publish two index msgs')

  await Promise.all([pify(alice.close)(true), pify(bob.close)(true)])

  t.end()
})

tape('alice writes index feeds and bob replicates them', async (t) => {
  alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    metafeeds: {
      seed: aliceMFSeed,
    },
    indexFeeds: {
      autostart: [
        { type: 'post', private: false },
        { type: 'contact', private: false },
      ],
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{ purpose: 'index' }, {}],
        1: null,
      },
    },
    timeout: CONNECTION_TIMEOUT,
    timers: { inactivity: INACTIVITY_TIMEOUT },
  })

  bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    metafeeds: {
      seed: bobMFSeed,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: null,
        1: [
          {
            purpose: 'index',
            metadata: {
              querylang: 'ssb-ql-0',
              query: { author: '$main', type: 'post', private: false },
            },
          },
        ],
      },
    },
    timeout: CONNECTION_TIMEOUT,
    timers: { inactivity: INACTIVITY_TIMEOUT },
  })

  t.equals(
    await alice.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    6, // v1 + shard A + contact index + post index + shardB + main
    'alice has 6 bendybutt msgs'
  )

  const connectionBA = await pify(bob.connect)(alice.getAddress())
  t.pass('peers are connected to each other')

  await sleep(REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  // Alice fully replicates Bob
  t.equals(
    await alice.db.query(
      where(and(type('post'), author(bob.id))),
      count(),
      toPromise()
    ),
    1,
    'alice has 1 post from bob'
  )

  t.equals(
    await alice.db.query(
      where(and(type('contact'), author(bob.id))),
      count(),
      toPromise()
    ),
    1,
    'alice has 1 contact from bob'
  )

  // Bob partially replicates Alice
  t.equals(
    await bob.db.query(
      where(and(type('post'), author(alice.id))),
      count(),
      toPromise()
    ),
    1,
    'bob has 1 post from alice'
  )

  t.equals(
    await bob.db.query(
      where(and(type('contact'), author(alice.id))),
      count(),
      toPromise()
    ),
    0,
    'bob does NOT have contact msgs from alice'
  )

  t.equals(
    await bob.db.query(
      where(and(type('metafeed/announce'), author(alice.id))),
      count(),
      toPromise()
    ),
    1,
    'bob has 1 metafeed/announce from alice'
  )

  t.equals(
    await bob.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    5, // v1 + shardA + post index + contact index + shardB
    'bob replicated 5 bendybutt msgs'
  )

  await pify(connectionBA.close)(true)

  t.end()
})

tape('carol acts as an intermediate between alice and bob', async (t) => {
  carol = createSsbServer({
    path: path.join(os.tmpdir(), 'server-carol'),
    keys: carolKeys,
    timeout: CONNECTION_TIMEOUT,
    timers: { inactivity: INACTIVITY_TIMEOUT },
    friends: { hops: 2 },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: null,
        1: [{ purpose: 'mygame' }, { purpose: 'index' }],
      },
    },
  })
  t.pass('carol initialized')

  // This needs to happen before publishing follows, otherwise carol
  // defaults to normal replication (which means she won't replicate meta feeds)
  await pify(carol.connect)(alice.getAddress())
  t.pass('carol is connected to alice')

  await Promise.all([
    pify(carol.db.publish)(u.follow(alice.id)),
    pify(carol.db.publish)(u.follow(bob.id)),
  ])
  t.pass('carol follows alice and bob')

  await sleep(REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  t.equals(
    await carol.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    5, // v1 + shardA + contact index + post index + shardB
    'carol replicated 5 bendybutt msgs'
  )

  t.equals(
    await carol.db.query(where(author(alice.id)), count(), toPromise()),
    3, // post + contact + metafeed/announce
    'carol replicated all of alices msgs'
  )

  await pify(carol.connect)(bob.getAddress())
  t.pass('carol is connected to bob')

  t.end()
})

tape('bob reconfigures to replicate all indexes from alice', async (t) => {
  bob.replicationScheduler.reconfigure({
    partialReplication: {
      0: null,
      1: [{ purpose: 'index' }],
    },
  })
  t.pass('reconfigure bob')

  await sleep(REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  t.equals(
    await bob.db.query(
      where(and(type('contact'), author(alice.id))),
      count(),
      toPromise()
    ),
    1,
    'bob has 1 contact msgs from alice'
  )

  t.end()
})

let gameFeed

tape('once bob blocks alice, he cant replicate subfeeds anymore', async (t) => {
  await pify(bob.db.publish)(u.block(alice.id))
  t.pass('bob blocked alice')

  await pify(alice.db.publish)({ type: 'post', text: 'Whatever' })
  t.pass('alice published a new post')

  gameFeed = await pify(alice.metafeeds.findOrCreate)({
    purpose: 'mygame',
    feedFormat: 'classic',
    metadata: {
      score: 0,
      whateverElse: true,
    },
  })
  t.pass('alice created a game subfeed ' + gameFeed.keys.id.slice(0, 20))

  await pify(alice.db.publishAs)(gameFeed.keys, {
    type: 'game',
    move: { x: 1, y: 0 },
  })
  t.pass('alice published something on the game subfeed')

  await sleep(REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  t.equals(
    await alice.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    8, // v1 + shardA + post idx + contact idx + shardB + main + shardC + game
    'alice has 8 bendybutt msgs'
  )

  t.equals(
    await bob.db.query(
      where(and(type('post'), author(alice.id))),
      count(),
      toPromise()
    ),
    1,
    'bob has 1 post from alice'
  )

  t.equals(
    await bob.db.query(
      where(and(type('contact'), author(alice.id))),
      count(),
      toPromise()
    ),
    1,
    'bob has 1 contact msg from alice'
  )

  t.equals(
    await bob.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    5, // v1 + shardA + post index + contact index + shardB
    'bob replicated 5 bendybutt msgs'
  )

  t.equals(
    await bob.db.query(where(type('game')), count(), toPromise()),
    0,
    'bob has not replicated the game subfeed'
  )

  t.end()
})

tape('once bob unblocks alice, he replicates her subfeeds', async (t) => {
  await pify(bob.db.publish)(u.follow(alice.id))

  await sleep(REPLICATION_TIMEOUT * 2)
  t.pass('replication period is over')

  t.equals(
    await bob.db.query(
      where(and(type('post'), author(alice.id))),
      count(),
      toPromise()
    ),
    2,
    'bob has 2 posts from alice'
  )

  t.equals(
    await bob.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    6, // v1 + shardA + post index + contact index + shardB + shardC
    'bob replicated 6 bendybutt msgs'
  )

  t.end()
})

tape('bob reconfigures to replicate a game feed from alice', async (t) => {
  bob.replicationScheduler.reconfigure({
    partialReplication: {
      0: [{ purpose: 'main' }, { purpose: 'index' }],
      1: [{ purpose: 'mygame' }, { purpose: 'index' }],
    },
  })
  t.pass('reconfigure bob')

  await sleep(3 * REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  t.equals(
    await bob.db.query(where(type('game')), count(), toPromise()),
    1,
    'bob has replicated the game subfeed'
  )

  const bobClock = await pify(bob.getVectorClock)()
  t.equals(bobClock[gameFeed.keys.id], 1, "bob's clock has the game feed")

  t.end()
})

tape('bob starts a root meta feed and indexes, alice replicates', async (t) => {
  alice.replicationScheduler.reconfigure({
    partialReplication: {
      0: [{ purpose: 'main' }, { purpose: 'mygame' }, { purpose: 'index' }],
      1: [{ purpose: 'mygame' }, { purpose: 'index' }],
    },
  })
  t.pass('reconfigure alice to partially replicate friends')

  // wait a bit so that alice is still replicating bob fully
  await sleep(1000)

  await pify(bob.indexFeeds.start)({
    author: bob.id,
    type: 'post',
    private: false,
  })
  await pify(bob.indexFeeds.start)({
    author: bob.id,
    type: 'contact',
    private: false,
  })

  await sleep(INDEX_WRITING_TIMEOUT)
  t.pass('waited for Bob to publish meta feed msgs')

  await sleep(REPLICATION_TIMEOUT * 2)
  t.pass('replication period is over')

  t.equals(
    await alice.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    13,
    // ALICE: v1 + shardA + post + contact + shardB + main + shardC + game
    // BOB: v1 + shardA + post + contact + shardB
    'alice replicated 13 bendybutt msgs'
  )

  t.end()
})

tape('alice tombstones a subfeed, and david cannot replicate it', async (t) => {
  await pify(alice.metafeeds.findAndTombstone)(
    { purpose: 'mygame' },
    'This game is too good'
  )

  david = createSsbServer({
    path: path.join(os.tmpdir(), 'server-david'),
    keys: davidKeys,
    timeout: CONNECTION_TIMEOUT,
    timers: { inactivity: INACTIVITY_TIMEOUT },
    friends: { hops: 2 },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: null,
        1: [{ purpose: 'mygame' }, { purpose: 'index' }],
      },
    },
  })
  t.pass('david initialized')

  // This needs to happen before publishing follows, otherwise carol
  // defaults to normal replication (which means she won't replicate meta feeds)
  await pify(david.connect)(alice.getAddress())
  t.pass('david is connected to alice')

  await pify(david.db.publish)(u.follow(alice.id))
  t.pass('david follows alice')

  await sleep(REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  t.equals(
    await david.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    13,
    // ALICE: v1 + shardA + shardB + post + contact + shardC + game + tombstone
    // BOB: v1 + shardA + shardB + post idx + contact idx
    'david replicated 13 bendybutt msgs'
  )

  const davidClock = await pify(david.getVectorClock)()
  t.notOk(davidClock[gameFeed.keys.id], "david's clock lacks the game feed")

  t.end()
})

tape('teardown', async (t) => {
  await Promise.all([
    pify(alice.close)(true),
    pify(bob.close)(true),
    pify(carol.close)(true),
    pify(david.close)(true),
  ])

  t.end()
})
