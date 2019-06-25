'use strict';

const impl = require('./savetxhandler')

exports.handler = async (event) => {
    return await impl.save(event);
};