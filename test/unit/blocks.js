// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: Unlicense

const tape = require('tape')
const pull = require('pull-stream')
const ssbKeys = require('ssb-keys')
const Server = require('scuttle-testbot')

tape('listen to friends stream and ebt.blocks initial blocked peers', (t) => {
  t.plan(7)
  const bobId = ssbKeys.generate().id
  t.pass('bob is ' + bobId)

  Server.use({
    name: 'friends',
    init(sbot) {
      return {
        graphStream() {
          return pull.empty()
        },
        hopStream() {
          return pull.values([
            {
              [bobId]: -1,
            },
          ])
        },
      }
    },
  })
    .use({
      name: 'ebt',
      init(sbot) {
        return {
          request(id, bool) {
            if (id !== sbot.id) {
              t.equals(id, bobId, 'request id matches bob')
              t.false(bool, 'request flag is false')
            }
          },
          block(orig, dest, bool) {
            t.equals(orig, sbot.id, 'self feed id')
            t.equals(dest, bobId, 'blocked feed id matches')
            t.equals(bool, true, 'bool matches')
            sbot.close((err) => {
              t.error(err, 'close sbot')
              t.end()
            })
          },
        }
      },
    })
    .use(require('../..'))
    .call(null, {
      replicationScheduler: {
        debouncePeriod: 0,
      },
    })
})

tape('listen to friends stream ebt.blocks subsequent blocks', (t) => {
  t.plan(15)
  const bobId = ssbKeys.generate().id

  const expectedRequest = [
    [bobId, false],
    [bobId, false],
  ]
  const expectedBlock = [
    [bobId, true],
    [bobId, false],
  ]

  Server.use({
    name: 'friends',
    init(sbot) {
      return {
        graphStream() {
          return pull.empty()
        },
        hopStream() {
          return pull.values([
            {
              [bobId]: -1,
            },
            {
              [bobId]: -2,
            },
          ])
        },
      }
    },
  })
    .use({
      name: 'ebt',
      init(sbot) {
        return {
          request(id, bool) {
            if (id !== sbot.id) {
              t.true(expectedRequest.length > 0, 'expected')
              const [expectedDest, expectedBool] = expectedRequest.shift()
              t.equals(id, expectedDest, 'request feed id matches')
              t.equals(bool, expectedBool, 'bool matches')
            }
          },
          block(orig, dest, bool) {
            t.true(expectedBlock.length > 0, 'expected')
            const [expectedDest, expectedBool] = expectedBlock.shift()
            t.equals(orig, sbot.id, 'self feed id')
            t.equals(dest, expectedDest, 'blocked feed id matches')
            t.equals(bool, expectedBool, 'bool matches')

            if (expectedBlock.length === 0 && expectedRequest.length === 0) {
              sbot.close((err) => {
                t.error(err, 'close sbot')
                t.end()
              })
            }
          },
        }
      },
    })
    .use(require('../..'))
    .call(null, {
      replicationScheduler: {
        debouncePeriod: 0,
      },
    })
})
