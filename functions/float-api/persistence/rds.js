'use strict';

const config = require('config');

const constants = require('../constants');
const logger = require('debug')('pluto:float:rds');

const { Pool } = require('pg');

// const pool = new Pool({
//     user: config.get('db.user'),
//     host: config.get('db.host'),
//     database: config.get('db.database'),
//     password: config.get('db.password'),
//     port: config.get('db.port')
// });

const pool = new Pool();

module.exports.addOrSubtractFloat = async (floatAdjustmentRequest = {
        clientId: 'some_saving_co', 
        floatId: 'cash_float',
        amount: 100 * 1e4,
        currency: 'ZAR',
        unit: constants.floatUnits.DEFAULT}) => {

    const client = await pool.connect();
    
    const queryResult = await client.query('select 1');
    logger('Query result: ', queryResult);
    
    return queryResult;
};

module.exports.allocateFloat = async([floatAllocationRequest = {
    clientId: 'some_saving_co',
    floatId: 'cash_float',
    amount: 20 * 1e4,
    currency: 'ZAR',
    unit: constants.floatUnits.DEFAULT,
    allocatedTo: 'bonus_pool'}]) => {

};

module.exports.allocateToUsers = async([floatUserAccRequest = {
    clientId: 'some_saving_co',
    floatId: 'cash_float',
    userId: 'universal-user-id',
    accountId: 'uid-of-account',
    amount: 10 * 1e4,
    currency: 'ZAR',
    unit: constants.floatUnits.DEFAULT
}]) => {

};