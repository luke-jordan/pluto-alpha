'use strict';

const logger = require('debug')('jupiter:message:picker-test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const proxyquire = require('proxyquire').noCallThru();

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));

const expect = chai.expect;

const getMessagesStub = sinon.stub();
const getAccountFigureStub = sinon.stub();
const fetchDynamoRowStub = sinon.stub();

const profileTable = config.get('tables.dynamoProfileTable');

const testUserId = uuid();
const testOpenMoment = moment().subtract(3, 'months');

const handler = proxyquire('../message-picking-handler', {
    './persistence/rds.msgpicker': {
        'getNextMessage': getMessagesStub, 
        'getUserAccountFigure': getAccountFigureStub,
        '@noCallThru': true
    },
    'dynamo-common': {
        'fetchSingleRow': fetchDynamoRowStub
    },
    '@noCallThru': true
});

describe('**** UNIT TESTING MESSAGE ASSEMBLY ****', () => {

    before(() => {
        fetchDynamoRowStub.withArgs(profileTable, { systemWideUserId: testUserId }, ['personal_name', 'family_name']).
            resolves({ personalName: 'Luke', familyName: 'Jordan' });
        fetchDynamoRowStub.withArgs(profileTable, { systemWideUserId: testUserId }, ['creation_time_epoch_millis']).
            resolves({ creationTimeEpochMillis: testOpenMoment.valueOf() });
        getAccountFigureStub.withArgs({ systemWideUserId: testUserId, operation: 'interest::sum::0' }).
            resolves({ currency: 'VND', unit: 'WHOLE_CURRENCY', amount: 100000 });
    });

    it('Fills in message templates properly', async () => {
        getMessagesStub.withArgs({ destinationUserId: testUserId }).resolves({ 
            destinationUserId: testUserId,
            template: 'Hello #{user_full_name}. Did you know you have earned #{total_interest} since you opened ' + 
                'your account in #{opened_date}.' 
        });

        const filledMessage = await handler.fetchAndFillInNextMessage(testUserId);
        logger('Filled message: ', filledMessage);
        expect(filledMessage).to.exist;
    });

    it('Dry run triggers without touching RDS etc', async () => {
        const authContext= { authorizer: { systemWideUserId: testUserId }};
        const testEvent = { queryStringParameters: { gameDryRun: true }, requestContext: authContext };
        const dryRunMessages = await handler.getNextMessageForUser(testEvent);
        expect(dryRunMessages).to.exist;
    });

});
