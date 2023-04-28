#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const git = require('simple-git')()
const { execSync, spawnSync } = require('child_process')
const { promisify } = require('util')
const github = require('@actions/github');
import fetch from 'node-fetch';

const exec = (str, cwd) => {
  const [cmd, ...args] = str.split(' ')
  const ret = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (ret.status) {
    console.error(ret)
    console.error(`Error: ${str} returned non-zero exit code`)
    process.exit(ret.status)
  }
  return ret
}

const getlog = promisify(git.log.bind(git))

const event = github.context.payload

const deployDir = path.join(process.cwd(), process.env.DEPLOY_DIR || './')
const srcPackageDir = path.join(process.cwd(), process.env.SRC_PACKAGE_DIR || './')

console.log('            using deploy directory : ' + deployDir)
console.log('using src directory (package.json) : ' + srcPackageDir)

let pkg = require(path.join(deployDir, 'package.json'))

const run = async () => {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('Merge-release requires NODE_AUTH_TOKEN')
  let latest
  try {
    latest = await fetch(`${process.env.NPM_REGISTRY_URL || 'https://registry.npmjs.org/'}${pkg.name}/latest`)
  } catch (e) {
    // unpublished
  }

  let messages

  if (latest) {
    if (latest.gitHead === process.env.GITHUB_SHA) return console.log('SHA matches latest release, skipping.')
    if (latest.gitHead) {
      try {
        let logs = await getlog({ from: latest.gitHead, to: process.env.GITHUB_SHA })
        messages = logs.all.map(r => r.message + '\n' + r.body)
      } catch (e) {
        latest = null
      }
    } else {
      latest = null
    }
  }
  if (!latest) {
    messages = (event.commits || []).map(commit => commit.message + '\n' + commit.body)
  }

  let version = 'patch'
  if (messages.map(message => message.includes('BREAKING CHANGE') || message.includes('!:')).includes(true)) {
    version = 'major'
  } else if (messages.map(message => message.toLowerCase().startsWith('feat')).includes(true)) {
    version = 'minor'
  }

  const setVersion = version => {
    const json = execSync(`jq '.version="${version}"' package.json`, { cwd: srcPackageDir })
    fs.writeFileSync(path.join(srcPackageDir, 'package.json'), json)

    if (deployDir !== './') {
      const deployJson = execSync(`jq '.version="${version}"' package.json`, { cwd: deployDir })
      fs.writeFileSync(path.join(deployDir, 'package.json'), deployJson)
    }
  }

  let currentVersion

  try {
    currentVersion = execSync(`npm view ${pkg.name} version`, { cwd: srcPackageDir }).toString()
  } catch (e) {
    // unpublished
  }

  if (!currentVersion) {
    currentVersion = '0.0.0'
  }

  setVersion(currentVersion)
  console.log('current:', currentVersion, '/', 'version:', version)
  let newVersion = execSync(`npm version --git-tag-version=false ${version}`, { cwd: srcPackageDir }).toString()
  newVersion = newVersion.replace(/(\r\n|\n|\r)/gm, '')
  setVersion(newVersion.slice(1))
  console.log('new version:', newVersion)

  if (pkg.scripts && pkg.scripts.publish) {
    exec(`npm run publish`, deployDir)
  } else {
    exec(`npm publish`, deployDir)
  }
  exec(`git checkout package.json`) // cleanup
  exec(`git tag ${newVersion}`)
  exec(`echo "::set-output name=version::${newVersion}"`) // set action event.{STEP_ID}.output.version
}

run()
