'use strict';

const logger = require('debug')('jupiter:boosts:test');
const moment = require('moment');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const insertBoostStub = sinon.stub();

const proxyquire = require('proxyquire');

const handler = proxyquire('../boost-handler', {
    'persistence/rds': {
        'insertBoost': insertBoostStub
    }
});

const resetStubs = () => testHelper.resetStubs(insertBoostStub);

const testStartTime = moment();
const testEndTime = moment().add(7, 'days');

describe('*** UNIT TEST BOOSTS *** General audience', () => {

    beforeEach(() => resetStubs());

    it('Happy path creating a time-limited simple, general boost', async () => {
        logger('About to create a simple boost');

        const mockInstruction = {
            boostType: 'SIMPLE',
            boostCategory: 'TIME_LIMITED',
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            startTimeMillis: testStartTime.valueOf(),
            endTimeMillis: testEndTime.valueOf(),
            conditionClause: 'save_event_greater_than #{threshold}',
            conditionValue: 'threshold: 2000000',
            boostAudience: 'GENERAL',
            boostAudienceSelection: 'random_sample #{0.33} from #{all_users}'
        };

        logger('Instruction assembled: ', mockInstruction);
    });

});

describe('*** UNIT TEST BOOSTS *** Individual or limited users', () => {

    it('Happy path inserting a referral-based individual boost', async () => {

    });

});