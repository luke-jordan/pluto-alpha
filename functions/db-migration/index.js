'use strict';

const migrator = require('./handler')


exports.handler = async (event) => {
    return await migrator.migrate(event);
};