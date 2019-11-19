'use strict';

const createMainTable = `
CREATE TABLE testingMigrations1 (
    id int primary key
);`;

const createSecondaryTable = `
CREATE TABLE testingMigrations2 (
    id int primary key
);`;
  
module.exports.generateSql = () => `${createMainTable}
${createSecondaryTable}`;
