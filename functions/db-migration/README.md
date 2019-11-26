# Migrations
This function is run on deploy.

It downloads all files in specific amazon s3 folders and stores said files in the local folder `functions/migrations/scrips/`.
It then runs the downloaded files as migrations.

You should create migration scripts as `.js` files in the Amazon s3 folders: 
Staging Folder: `s3://jupiter.db.migration.scripts/staging`
Production Folder: `s3://jupiter.db.migration.scripts/master` 
 
The migration scripts should follow the naming format:

```
00001_create-initial-tables.js
00002-alter-initial-tables.js
00003_alter-initial-tables-again.js
```

The numbering in file names is super important, and migrations are guaranteed to run in the same order every time, on every system. There are no rollbacks only rolling forward, thus in order to fix an error, please write an additional migration script.

Note that file names cannot be changed later.

Here is a sample migration script:

```
const createMainTable = `
CREATE TABLE customers (
    id int primary key
);`

const createSecondaryTable = `
CREATE TABLE orders (
    id int primary key
);`
  
module.exports.generateSql = () => `${createMainTable}
${createSecondaryTable}`
```

The sample script creates a `customers` and `orders` tables.

`N/B`: All migration scripts must export a method called `generateSql` which returns a string literal as shown in the example above.


For further information, please view the documentation of the library on which our migration system is based: [https://www.npmjs.com/package/postgres-migrations](https://www.npmjs.com/package/postgres-migrations)