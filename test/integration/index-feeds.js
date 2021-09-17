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
  count,
  toPromise,
} = require('ssb-db2/operators')
const sleep = require('util').promisify(setTimeout)
const bendyButtEBTFormat = require('ssb-ebt/formats/bendy-butt')
const indexedEBTFormat = require('ssb-ebt/formats/indexed')
const { keysFor } = require('../misc/util')

const createSsbServer = SecretStack({ caps })
  .use(require('ssb-db2'))
  .use(require('ssb-db2/compat/ebt'))
  .use(require('ssb-ebt'))
  .use(require('ssb-friends'))
  .use(require('ssb-meta-feeds'))
  .use(require('ssb-meta-feeds-rpc'))
  .use(require('ssb-index-feed-writer'))
  .use(require('../..'))

const CONNECTION_TIMEOUT = 500 // ms
const REPLICATION_TIMEOUT = 10000 // ms
const INDEX_WRITING_TIMEOUT = 2000 // ms

const aliceKeys = keysFor('alice')
const bobKeys = keysFor('bob')

tape('setup', async (t) => {
  rimraf.sync(path.join(os.tmpdir(), 'server-alice'))
  rimraf.sync(path.join(os.tmpdir(), 'server-bob'))

  const alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    timeout: CONNECTION_TIMEOUT,
    indexFeedWriter: {
      autostart: [{ type: 'post', private: false }],
    },
  })

  const bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    timeout: CONNECTION_TIMEOUT,
  })

  t.pass('started both peers')
  t.pass('alice is ' + alice.id)
  t.pass('bob is ' + bob.id)

  // Wait for all bots to be ready
  await sleep(500)

  const following = true
  await Promise.all([
    // All peers publish a post
    pify(alice.db.publish)({ type: 'post', text: 'My name is Alice' }),
    pify(bob.db.publish)({ type: 'post', text: 'My name is Bob' }),

    // alice and bob follow each other
    pify(alice.db.publish)({ type: 'contact', contact: bob.id, following }),
    pify(bob.db.publish)({ type: 'contact', contact: alice.id, following }),
  ])
  t.pass('published all the messages')

  await sleep(INDEX_WRITING_TIMEOUT)
  t.pass('waited for Alice to publish meta feed msgs')

  await Promise.all([pify(alice.close)(true), pify(bob.close)(true)])

  t.end()
})

tape('alice writes index feeds and bob replicates them', async (t) => {
  const alice = createSsbServer({
    path: path.join(os.tmpdir(), 'server-alice'),
    keys: aliceKeys,
    timeout: CONNECTION_TIMEOUT,
    indexFeedWriter: {
      autostart: [{ type: 'post', private: false }],
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
                  metadata: {
                    querylang: 'ssb-ql-0',
                    query: { author: '$main', type: 'post', private: false },
                  },
                  $format: 'indexed'
                },
              ],
            },
          ],
        },
        1: null,
      },
    },
  })

  const bob = createSsbServer({
    path: path.join(os.tmpdir(), 'server-bob'),
    keys: bobKeys,
    timeout: CONNECTION_TIMEOUT,
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
                  $format: 'indexed'
                },
              ],
            },
          ],
        },
      },
    },
  })

  const connectionBA = await pify(bob.connect)(alice.getAddress())
  t.pass('peers are connected to each other')

  await sleep(REPLICATION_TIMEOUT)
  t.pass('replication period is over')

  console.log('ALICE HAS----------------')
  console.log(
    (await alice.db.query(toPromise())).map((msg) => [
      msg.value.author,
      msg.value.content,
    ])
  )
  console.log('-------------------------\n')
  console.log('BOB HAS------------------')
  console.log(
    (await bob.db.query(toPromise())).map((msg) => [
      msg.value.author,
      msg.value.content,
    ])
  )
  console.log('-------------------------')

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

  await pify(connectionBA.close)(true)

  await Promise.all([pify(alice.close)(true), pify(bob.close)(true)])

  t.end()
})
