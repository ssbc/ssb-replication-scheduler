// SPDX-FileCopyrightText: 2022 Jacob Karlsson
//
// SPDX-License-Identifier: Unlicense

const test = require('tape')
const rimraf = require('rimraf')
const SecretStack = require('secret-stack')
const caps = require('ssb-caps')
const ssbKeys = require('ssb-keys')
const p = require('util').promisify
const {
  where,
  author,
  and,
  type,
  count,
  toPromise,
} = require('ssb-db2/operators')
const u = require('../misc/util')

const sleep = p(setTimeout)
const REPLICATION_TIMEOUT = 4e3

const Server = (name, opts = {}) => {
  const path = `/tmp/ssb-replication-tests-${name}`
  rimraf.sync(path)

  const sbot = SecretStack({ caps })
    .use(require('ssb-db2/core'))
    .use(require('ssb-classic'))
    .use(require('ssb-box'))
    .use(require('ssb-box2'))
    .use(require('ssb-db2/compat/publish'))
    .use(require('ssb-db2/compat/post'))
    .use(require('ssb-db2/compat/ebt'))
    .use(require('ssb-bendy-butt'))
    .use(require('ssb-conn'))
    .use(require('ssb-ebt'))
    .use(require('ssb-friends'))
    .use(require('ssb-meta-feeds'))
    .use(require('ssb-tribes2'))
    .use(require('ssb-subset-rpc'))
    .use(require('ssb-index-feeds'))
    .use(require('../..'))({
    path,
    keys: ssbKeys.generate('ed25519', name),
    ...opts,
  })

  return sbot
}

const aliceSeed = Buffer.from(
  '000000000000000000000000000000000000000000000000000000000000a71ce',
  'hex'
)
const bobSeed = Buffer.from(
  '00000000000000000000000000000000000000000000000000000000000000b0b',
  'hex'
)
const carolSeed = Buffer.from(
  '000000000000000000000000000000000000000000000000000000000000ca507',
  'hex'
)

test('group members who are not friends replicate each other', async (t) => {
  const alice = Server('alice', {
    metafeeds: {
      seed: aliceSeed,
    },
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'group/additions' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  const bob = Server('bob', {
    metafeeds: {
      seed: bobSeed,
    },
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'group/additions' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  const carol = Server('carol', {
    metafeeds: {
      seed: carolSeed,
    },
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'group/additions' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  await alice.tribes2.start()
  await bob.tribes2.start()
  await carol.tribes2.start()

  await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()
  const carolRoot = await p(carol.metafeeds.findOrCreate)()
  t.pass('created root metafeeds for alice, bob, carol')

  await Promise.all([
    p(alice.db.publish)(u.follow(bob.id)),
    p(alice.db.publish)(u.follow(carol.id)),
    p(bob.db.publish)(u.follow(alice.id)),
    p(carol.db.publish)(u.follow(alice.id)),
  ])
  t.pass('alice is mutually following bob and carol')

  const connectionBA1 = await p(bob.connect)(alice.getAddress())
  const connectionCA1 = await p(carol.connect)(alice.getAddress())
  t.pass('bob and carol connected to alice')
  await sleep(REPLICATION_TIMEOUT)
  await sleep(REPLICATION_TIMEOUT)

  t.equals(
    await alice.db.query(
      where(and(author(bob.id), type('contact'))),
      count(),
      toPromise()
    ),
    1,
    'alice has replicated bob main'
  )
  t.equals(
    await alice.db.query(
      where(and(author(carol.id), type('contact'))),
      count(),
      toPromise()
    ),
    1,
    'alice has replicated carol main'
  )
  t.equals(
    await bob.db.query(
      where(and(author(alice.id), type('contact'))),
      count(),
      toPromise()
    ),
    2,
    'bob has replicated alice main'
  )
  t.equals(
    await carol.db.query(
      where(and(author(alice.id), type('contact'))),
      count(),
      toPromise()
    ),
    2,
    'carol has replicated alice main'
  )
  t.equals(
    await bob.db.query(
      where(and(author(carol.id), type('contact'))),
      count(),
      toPromise()
    ),
    0,
    'bob has NOT replicated carol main'
  )
  t.equals(
    await carol.db.query(
      where(and(author(bob.id), type('contact'))),
      count(),
      toPromise()
    ),
    0,
    'carol has NOT replicated bob main'
  )

  await p(connectionBA1.close)(true)
  await p(connectionCA1.close)(true)
  t.pass('bob and carol disconnected from alice')

  const group = await alice.tribes2.create()
  t.pass('alice created a group')

  await alice.tribes2
    .addMembers(group.id, [bobRoot.id, carolRoot.id])
    .catch((err) => {
      console.error('cant add members', err)
      t.fail(err)
    })
  t.pass('alice added bob and carol to the group')

  const connectionBA2 = await p(bob.connect)(alice.getAddress())
  const connectionCA2 = await p(carol.connect)(alice.getAddress())
  t.pass('bob and carol connected to alice')
  await sleep(REPLICATION_TIMEOUT)
  await bob.tribes2.acceptInvite(group.id).catch(t.error)
  await carol.tribes2.acceptInvite(group.id).catch(t.error)
  t.pass('bob and carol are members of the group')

  await p(connectionBA2.close)(true)
  await p(connectionCA2.close)(true)
  t.pass('bob and carol disconnected from alice')

  const carolHi = await carol.tribes2
    .publish({ type: 'post', text: 'hi', recps: [group.id] })
    .catch((err) => {
      console.error('publish failed:', err)
      t.fail(err)
    })
  t.pass('carol published a message to the group')

  const connectionBC1 = await p(bob.connect)(carol.getAddress())
  t.pass('bob connected to carol')
  await sleep(REPLICATION_TIMEOUT)
  await sleep(REPLICATION_TIMEOUT)

  const msg = await p(bob.db.get)(carolHi.key).catch(t.error)
  t.equals(msg.content.text, 'hi', "bob has replicated carol's group msg")

  await p(connectionBC1.close)(true)
  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
    p(carol.close)(true),
  ])
})

test('group members who block each other replicate each other', async (t) => {
  const alice = Server('alice', {
    metafeeds: {
      seed: aliceSeed,
    },
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'group/additions' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  const bob = Server('bob', {
    metafeeds: {
      seed: bobSeed,
    },
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'group/additions' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  const carol = Server('carol', {
    metafeeds: {
      seed: carolSeed,
    },
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'group/additions' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  await alice.tribes2.start()
  await bob.tribes2.start()
  await carol.tribes2.start()

  await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()
  const carolRoot = await p(carol.metafeeds.findOrCreate)()
  t.pass('created root metafeeds for alice, bob, carol')

  await Promise.all([
    p(alice.db.publish)(u.follow(bob.id)),
    p(alice.db.publish)(u.follow(carol.id)),
    p(bob.db.publish)(u.follow(alice.id)),
    p(carol.db.publish)(u.follow(alice.id)),
  ])
  t.pass('alice is mutually following bob and carol')

  await p(bob.db.publish)(u.block(carol.id))
  await p(carol.db.publish)(u.block(bob.id))
  t.pass('bob and carol are blocking each other')

  const connectionBA = await p(bob.connect)(alice.getAddress())
  const connectionCA = await p(carol.connect)(alice.getAddress())
  t.pass('bob and carol connected to alice')
  await sleep(REPLICATION_TIMEOUT)
  await sleep(REPLICATION_TIMEOUT)

  t.equals(
    await alice.db.query(
      where(and(author(bob.id), type('contact'))),
      count(),
      toPromise()
    ),
    2,
    'alice has replicated bob main'
  )
  t.equals(
    await alice.db.query(
      where(and(author(carol.id), type('contact'))),
      count(),
      toPromise()
    ),
    2,
    'alice has replicated carol main'
  )
  t.equals(
    await bob.db.query(
      where(and(author(alice.id), type('contact'))),
      count(),
      toPromise()
    ),
    2,
    'bob has replicated alice main'
  )
  t.equals(
    await carol.db.query(
      where(and(author(alice.id), type('contact'))),
      count(),
      toPromise()
    ),
    2,
    'carol has replicated alice main'
  )
  t.equals(
    await bob.db.query(
      where(and(author(carol.id), type('contact'))),
      count(),
      toPromise()
    ),
    0,
    'bob has NOT replicated carol main'
  )
  t.equals(
    await carol.db.query(
      where(and(author(bob.id), type('contact'))),
      count(),
      toPromise()
    ),
    0,
    'carol has NOT replicated bob main'
  )

  const group = await alice.tribes2.create()
  t.pass('alice created a group')

  await alice.tribes2
    .addMembers(group.id, [bobRoot.id, carolRoot.id])
    .catch((err) => {
      console.error('cant add members', err)
      t.fail(err)
    })
  t.pass('alice added bob and carol to the group')

  await sleep(REPLICATION_TIMEOUT)

  await bob.tribes2.acceptInvite(group.id).catch(t.error)
  await carol.tribes2.acceptInvite(group.id).catch(t.error)
  t.pass('bob and carol are members of the group')

  const carolHi = await carol.tribes2
    .publish({ type: 'post', text: 'hi', recps: [group.id] })
    .catch((err) => {
      console.error('publish failed:', err)
      t.fail(err)
    })
  t.pass('carol published a message to the group')

  await sleep(REPLICATION_TIMEOUT)

  const msg = await p(bob.db.get)(carolHi.key).catch(t.error)
  t.equals(msg.content.text, 'hi', "bob has replicated carol's group msg")

  await p(connectionBA.close)(true)
  await p(connectionCA.close)(true)
  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
    p(carol.close)(true),
  ])
})

test('group members replicate each other eventually', async (t) => {
  const alice = Server('alice', {
    metafeeds: {
      seed: aliceSeed,
    },
    friends: {
      hops: 2,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{}],
        group: [{}],
      },
    },
  })

  const bob = Server('bob', {
    metafeeds: {
      seed: bobSeed,
    },
    friends: {
      hops: 2,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{}],
        group: [{}],
      },
    },
  })

  const carol = Server('carol', {
    metafeeds: {
      seed: carolSeed,
    },
    friends: {
      hops: 2,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{}],
        group: [{}],
      },
    },
  })

  await alice.tribes2.start()
  await bob.tribes2.start()
  await carol.tribes2.start()

  await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()
  const carolRoot = await p(carol.metafeeds.findOrCreate)()
  t.pass('created root metafeeds for alice, bob, carol')

  await Promise.all([
    p(alice.db.publish)(u.follow(bob.id)),
    p(alice.db.publish)(u.follow(carol.id)),
    p(bob.db.publish)(u.follow(alice.id)),
    p(carol.db.publish)(u.follow(alice.id)),
  ])
  t.pass('alice is mutually following bob and carol')

  const connectionBA = await p(bob.connect)(alice.getAddress())
  const connectionCA = await p(carol.connect)(alice.getAddress())
  t.pass('bob and carol connected to alice')
  await sleep(REPLICATION_TIMEOUT)
  await sleep(REPLICATION_TIMEOUT)

  t.equals(
    await alice.db.query(
      where(and(author(bob.id), type('contact'))),
      count(),
      toPromise()
    ),
    1,
    'alice has replicated bob main'
  )
  t.equals(
    await alice.db.query(
      where(and(author(carol.id), type('contact'))),
      count(),
      toPromise()
    ),
    1,
    'alice has replicated carol main'
  )
  t.equals(
    await bob.db.query(
      where(and(author(alice.id), type('contact'))),
      count(),
      toPromise()
    ),
    2,
    'bob has replicated alice main'
  )
  t.equals(
    await carol.db.query(
      where(and(author(alice.id), type('contact'))),
      count(),
      toPromise()
    ),
    2,
    'carol has replicated alice main'
  )
  t.equals(
    await bob.db.query(
      where(and(author(carol.id), type('contact'))),
      count(),
      toPromise()
    ),
    1,
    'bob has replicated carol main'
  )
  t.equals(
    await carol.db.query(
      where(and(author(bob.id), type('contact'))),
      count(),
      toPromise()
    ),
    1,
    'carol has replicated bob main'
  )

  const group = await alice.tribes2.create()
  t.pass('alice created a group')

  await alice.tribes2.addMembers(group.id, [bobRoot.id]).catch((err) => {
    console.error('cant add members', err)
    t.fail(err)
  })
  t.pass('alice added bob to the group')

  const additionMsgs = await alice.db.query(
    where(type('group/add-member')),
    toPromise()
  )
  t.equal(additionMsgs.length, 2, 'alice published 2 group/add-member msgs')

  await sleep(REPLICATION_TIMEOUT)

  await bob.tribes2.acceptInvite(group.id).catch(t.error)
  t.pass('bob is a member of the group')

  const bobHi = await bob.tribes2
    .publish({ type: 'post', text: 'hi', recps: [group.id] })
    .catch((err) => {
      console.error('publish failed:', err)
      t.fail(err)
    })
  t.pass('bob published a message to the group')

  await sleep(REPLICATION_TIMEOUT)

  const msgAtA = await p(alice.db.get)(bobHi.key).catch(t.error)
  t.equals(msgAtA.content.text, 'hi', "alice has replicated bob's group msg")

  const addAtC1 = await p(carol.db.get)(additionMsgs[0].key).catch(t.error)
  t.equals(
    typeof addAtC1.content,
    'string',
    "carol has replicated alice's encrypted addition msg 1"
  )
  const addAtC2 = await p(carol.db.get)(additionMsgs[1].key).catch(t.error)
  t.equals(
    typeof addAtC2.content,
    'string',
    "carol has replicated alice's encrypted addition msg 2"
  )

  await alice.tribes2.addMembers(group.id, [carolRoot.id]).catch((err) => {
    console.error('cant add members', err)
    t.fail(err)
  })
  t.pass('alice added carol to the group')

  await sleep(REPLICATION_TIMEOUT)

  await carol.tribes2.acceptInvite(group.id).catch(t.error)
  t.pass('carol is a member of the group')

  const msgAtC = await p(alice.db.get)(bobHi.key).catch(t.error)
  t.equals(msgAtC.content.text, 'hi', "carol has replicated bob's group msg")

  await p(connectionBA.close)(true)
  await p(connectionCA.close)(true)
  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
    p(carol.close)(true),
  ])
})
