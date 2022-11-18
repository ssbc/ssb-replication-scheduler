const test = require('tape')
const rimraf = require('rimraf')
const SecretStack = require('secret-stack')
const caps = require('ssb-caps')
const ssbKeys = require('ssb-keys')
const bendyButtFormat = require('ssb-ebt/formats/bendy-butt')
const p = require('util').promisify
const u = require('../misc/util')
const pull = require('pull-stream')

const sleep = p(setTimeout)
const REPLICATION_TIMEOUT = 4e3

const Server = (name, opts = {}) => {
  const path = `/tmp/ssb-replication-tests-${name}`
  rimraf.sync(path)

  const sbot = SecretStack({ caps })
    .use(require('ssb-db2/core'))
    .use(require('ssb-db2/compat/ebt'))
    .use(require('ssb-db2/compat/publish'))
    .use(require('ssb-db2/compat/post'))
    .use(require('ssb-classic'))
    .use(require('ssb-bendy-butt'))
    .use(require('ssb-box'))
    .use(require('ssb-box2'))
    .use(require('ssb-conn'))
    .use(require('ssb-ebt'))
    .use(require('ssb-friends'))
    .use(require('ssb-tribes2'))
    .use(require('ssb-meta-feeds'))
    .use(require('ssb-subset-rpc'))
    .use(require('ssb-index-feeds'))
    .use(require('../..'))({
    path,
    keys: ssbKeys.generate(),
    ...opts,
  })

  //sbot.ebt.registerFormat(bendyButtFormat)

  return sbot
}

async function waitUntilMember(person, groupId) {
  let isMember = false
  for (let i = 0; !isMember && i < 50; i++) {
    await person.tribes2
      .get(groupId)
      .then(() => {
        isMember = true
      })
      .catch(() => {})
    await p(setTimeout)(100)
  }
  if (!isMember) {
    throw new Error('Timed out waiting for person to be member of group')
  }
}

test('You replicate other people in a group', async (t) => {
  const alice = Server('alice', {
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'invitations' }],
      },
    },
  })

  const bob = Server('bob', {
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'invitations' }],
        group: [{ purpose: '$groupSecret' }],
      },
    },
  })

  const carol = Server('carol', {
    friends: {
      hops: 1,
    },
    replicationScheduler: {
      debouncePeriod: 1,
      partialReplication: {
        0: [{}],
        1: [{ purpose: 'main' }, { purpose: 'invitations' }],
      },
    },
  })

  alice.tribes2.start()
  bob.tribes2.start()
  carol.tribes2.start()

  const aliceRoot = await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()
  const carolRoot = await p(carol.metafeeds.findOrCreate)()
  console.log('found metafeeds')

  await Promise.all([
    p(alice.db.publish)(u.follow(bob.id)),
    p(alice.db.publish)(u.follow(carol.id)),
    p(bob.db.publish)(u.follow(alice.id)),
    p(carol.db.publish)(u.follow(alice.id)),
  ])

  console.log('replicating after follows')

  await p(bob.connect)(alice.getAddress())
  await p(carol.connect)(alice.getAddress())
  await sleep(REPLICATION_TIMEOUT)
  await sleep(REPLICATION_TIMEOUT)
  //TODO: maybe close the connections at this point

  console.log('group creating')
  const group = await alice.tribes2.create()

  console.log('group created')
  await alice.tribes2
    .addMembers(group.id, [bobRoot.id, carolRoot.id])
    .catch((err) => {
      console.error('cant add members', err)
      t.error(err)
    })
  console.log('added members')
  console.log('alice is', alice.id)

  await p(bob.connect)(alice.getAddress())
  await p(carol.connect)(alice.getAddress())
  await sleep(REPLICATION_TIMEOUT)
  await waitUntilMember(bob, group.id).catch(t.error)
  await waitUntilMember(carol, group.id).catch(t.error)

  const carolHi = await carol.tribes2
    .publish({ type: 'post', text: 'hi', recps: [group.id] })
    .catch((err) => {
      console.log('publish failed:', err)
      t.error(err)
    })

  console.log('carol published')

  await p(bob.connect)(carol.getAddress())
  await sleep(REPLICATION_TIMEOUT)
  await sleep(REPLICATION_TIMEOUT)
  console.log('connected bob and carol')
  //console.log('trees')
  //await p(carol.metafeeds.printTree)(carolRoot.id, { id: true })
  //await p(bob.metafeeds.printTree)(carolRoot.id, { id: true })

  const msg = await p(bob.db.get)(carolHi.key).catch(t.error)

  t.equals(msg.content.text, 'hi')

  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
    p(carol.close)(true),
  ])
  t.end()
})
