#!/usr/bin/env node

/*
 * Derived from: https://github.com/tcurdt/package-utils
 */

const fs = require('fs');

const functionFolders = [
    './functions/admin-api',
    './functions/boost-api',
    './functions/audience-selection',
    './functions/float-api',
    './functions/user-activity-api',
    './functions/user-existence-api',
    './functions/user-messaging-api',
    './functions/referral-api',
    './functions/third-parties',
    './functions/warmup',
    './functions/db-migration', 
];

const moduleFolders =[
    './modules/rds-common',
    './modules/ops-util-common',
    './modules/publish-common'
];

// note merge objects is recursive so can't just include dependencies keys, have to instead exclude like this
const excludedKeys = ['name', 'version', 'description', 'main', 'scripts', 'author', 'license', 'directories']

function mergeObjects(objects, cb) {
  const r = {}
  objects.forEach(function(object) {
    Object.keys(object).filter((key) => excludedKeys.indexOf(key) < 0).forEach(function(key) {
      const current = r[key]
      const next = object[key]
      if (current) {
        if (typeof current === 'object' && typeof next === 'object') {
          r[key] = mergeObjects([ current, next ], cb)
        } else {
          if (current !== next) {
            r[key] = cb(current, next)
          }
        }
      } else {
        r[key] = next
      }
    })
  })
  return r
};

function mergePackageJsons(folders) {
    const files = folders.map((folder) => `${folder}/package.json`);
    const merged = mergeObjects(files.map(function(file) {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    }), function(a, b) {
    if (typeof a !== typeof b) {
        console.error('Not sure how to merge',
        JSON.stringify(a),
        JSON.stringify(b))
        process.exit(1)
    } else {
        return b
    }
    });
    return merged;
};

const typeOfPackages = process.argv[2];
let folders = [];
if (typeOfPackages === 'modules')
  folders = moduleFolders;
else if (typeOfPackages === 'functions')
  folders = functionFolders;
else
  console.log('*** ERROR: Bad argument, will do little');

console.log('Merging packages in folders: ', folders);
const merged = mergePackageJsons(folders);
// console.log(JSON.stringify(merged, null, 2));
fs.writeFileSync('./package.json', JSON.stringify(merged, null, 2) + '\n');
console.log('Consolidated package.json outputted');
