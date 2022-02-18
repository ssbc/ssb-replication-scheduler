// SPDX-FileCopyrightText: 2021 Andre 'Staltz' Medeiros
//
// SPDX-License-Identifier: LGPL-3.0-only

const { QL0 } = require('ssb-subset-ql')

/**
 * Algorithms for the "replication template" object from the SSB config.
 */
module.exports = class Template {
  constructor(node) {
    this._rootNode = node
  }

  hasIndexLeaf() {
    const indexes = this._find(
      this._rootNode,
      (node) => node.feedpurpose === 'indexes'
    )
    if (!indexes) return false
    const leaf = this._find(indexes, (node) => node['$format'] === 'indexed')
    return !!leaf
  }

  _find(node, fn) {
    if (!node) return null
    if (fn(node)) return node

    if (node.subfeeds && Array.isArray(node.subfeeds)) {
      for (const childNode of node.subfeeds) {
        if (this._find(childNode, fn)) {
          return childNode
        }
      }
    }
  }

  matchBranch(branch, mainFeedId) {
    return this._matchBranch(branch, this._rootNode, mainFeedId)
  }

  _matchBranch(branch, node, mainFeedId) {
    if (branch.length === 0) return null
    const head = branch[0]
    const [feedId, details] = head

    // Head is a root meta feed:
    if (!details) {
      const keys = Object.keys(node)
      const rootMatches =
        keys.length === 1 &&
        keys[0] === 'subfeeds' &&
        Array.isArray(node.subfeeds)

      if (!rootMatches) {
        return null
      } else if (branch.length >= 2) {
        const childBranch = branch.slice(1)
        for (const childNode of node.subfeeds) {
          const matched = this._matchBranch(childBranch, childNode, mainFeedId)
          if (matched) return matched
        }
        return null
      } else {
        return node
      }
    }

    // Head is a subfeed:
    if (details) {
      // If present, feedpurpose must match
      if (node.feedpurpose && details.feedpurpose !== node.feedpurpose) {
        return null
      }

      // If present, metadata must match
      if (node.metadata && details.metadata) {
        // If querylang is present, match ssb-ql-0 queries
        if (node.metadata.querylang !== details.metadata.querylang) {
          return null
        }
        if (node.metadata.querylang === 'ssb-ql-0') {
          if (!QL0.parse(details.metadata.query)) return null
          if (node.metadata.query) {
            const nodeQuery = { ...node.metadata.query }
            if (nodeQuery.author === '$main') nodeQuery.author = mainFeedId
            if (!QL0.isEquals(details.metadata.query, nodeQuery)) {
              return null
            }
          }
        }

        // Any other metadata field must match exactly
        for (const field of Object.keys(node.metadata)) {
          // Ignore these because we already handled them:
          if (field === 'query') continue
          if (field === 'querylang') continue

          if (details.metadata[field] !== node.metadata[field]) {
            return null
          }
        }
      }

      if (Array.isArray(node.subfeeds) && branch.length >= 2) {
        const childBranch = branch.slice(1)
        for (const childNode of node.subfeeds) {
          const matched = this._matchBranch(childBranch, childNode, mainFeedId)
          if (matched) return matched
        }
        return null
      } else {
        return node
      }
    }

    return null
  }
}
