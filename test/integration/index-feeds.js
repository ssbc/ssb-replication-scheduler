const tape = require('tape')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const caps = require('ssb-caps')
const SecretStack = require('secret-stack')
const pify = require('promisify-4loc')
const {
  where,
  and,
  type,
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
  .use(require('ssb-ebt'))
  .use(require('ssb-friends'))
  .use(require('ssb-meta-feeds'))
  .use(require('ssb-meta-feeds-rpc'))
  .use(require('ssb-index-feed-writer'))
  .use(require('../..'))

const CONNECTION_TIMEOUT = 1e3
const INACTIVITY_TIMEOUT = 60e3
const REPLICATION_TIMEOUT = 8e3
const INDEX_WRITING_TIMEOUT = 3e3

const aliceKeys = u.keysFor('alice')
const bobKeys = u.keysFor('bob')
const carolKeys = u.keysFor('carol')
let alice
let bob
let carol
let connectionBA
let connectionCA
let connectionCB

tape('setup', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'))
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'))
  rimraf.sync(path.join(os.tmpdir(), 'server-carol'))

  alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    timeout: CONNECTION_TIMEOUT,
    timers: { inactivity: INACTIVITY_TIMEOUT },
    indexFeedWriter: {
      autostart: [
        { type: 'post', private: false },
        { type: 'contact', private: false },
      ],
    },
  })

  bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
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

  await sleep(INDEX_WRITING_TIMEOUT)
  t.pass('waited for Alice to publish meta feed msgs')

  await Promise.all([pify(alice.close)(true), pify(bob.close)(true)])

  t.end()
})

tape('alice writes index feeds and bob replicates them', async (t) => {
  alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    timeout: CONNECTION_TIMEOUT,
    timers: { inactivity: INACTIVITY_TIMEOUT },
    indexFeedWriter: {
      autostart: [
        { type: 'post', private: false },
        { type: 'contact', private: false },
      ],
    },
    replicationScheduler: {
      partialReplication: {
        0: {
          subfeeds: [
            { feedpurpose: 'main' },
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
        1: null,
      },
    },
  })

  bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    timeout: CONNECTION_TIMEOUT,
    timers: { inactivity: INACTIVITY_TIMEOUT },
    replicationScheduler: {
      partialReplication: {
        0: null,
        1: {
          subfeeds: [
            {
              feedpurpose: 'indexes',
              subfeeds: [
                {
                  metadata: {
                    querylang: 'ssb-ql-0',
                    query: { author: '$main', type: 'post', private: false },
                  },
                  $format: 'indexed',
                },
              ],
            },
          ],
        },
      },
    },
  })

  t.equals(
    await alice.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    4, // add main + add indexes + add post index + add contact index
    'alice has 4 bendybutt msgs'
  )

  connectionBA = await pify(bob.connect)(alice.getAddress())
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
    4, // add main + add indexes + add post index + add contact index
    'bob replicated 4 bendybutt msgs'
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
      partialReplication: {
        0: null,
        1: {
          subfeeds: [
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
      },
    },
  })
  t.pass('carol initialized')

  // This needs to happen before publishing follows, otherwise carol
  // defaults to normal replication (which means she won't replicate meta feeds)
  connectionCA = await pify(carol.connect)(alice.getAddress())
  t.pass('carol is connected to alice')

  await pify(carol.db.publish)(u.follow(alice.id))
  t.pass('carol follows alice')

  await sleep(REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  t.equals(
    await carol.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    4, // add main + add indexes + add post index + add contact index
    'carol replicated 4 bendybutt msgs'
  )

  t.equals(
    await carol.db.query(where(author(alice.id)), count(), toPromise()),
    3, // post + contact + metafeed/announce
    'carol replicated all of alices msgs'
  )

  connectionCB = await pify(carol.connect)(bob.getAddress())
  t.pass('carol is connected to bob')

  t.end()
})

tape('bob reconfigures to replicate everything from alice', async (t) => {
  bob.replicationScheduler.reconfigure({
    partialReplication: {
      0: null,
      1: {
        subfeeds: [
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

tape('once bob blocks alice, he cant replicate subfeeds anymore', async (t) => {
  await pify(bob.db.publish)(u.block(alice.id))
  t.pass('bob blocked alice')

  await pify(alice.db.publish)({ type: 'post', text: 'Whatever' })
  t.pass('alice published a new post')

  const aliceRootMF = await pify(alice.metafeeds.find)()
  await pify(alice.metafeeds.create)(aliceRootMF, {
    feedpurpose: 'mygame',
    feedformat: 'classic',
    metadata: {
      score: 0,
      whateverElse: true,
    },
  })
  t.pass('alice created a game subfeed')

  await sleep(REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  t.equals(
    await alice.db.query(where(authorIsBendyButtV1()), count(), toPromise()),
    5, // add main + add indexes + add post index + add contact index + add game
    'alice has 5 bendybutt msgs'
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
    4, // add main + add indexes + add post index + add contact index
    'bob replicated 4 bendybutt msgs'
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
    5, // add main + add indexes + add post index + add contact index + add game
    'bob replicated 5 bendybutt msgs'
  )

  t.end()
})

tape('teardown', async (t) => {
  await Promise.all([
    pify(alice.close)(true),
    pify(bob.close)(true),
    pify(carol.close)(true),
  ])

  t.end()
})
