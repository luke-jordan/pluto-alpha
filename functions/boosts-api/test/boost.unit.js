'use strict';

const logger = require('debug')('jupiter:boosts:test');
const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const insertBoostStub = sinon.stub();
const momentStub = sinon.stub();

const proxyquire = require('proxyquire');

const handler = proxyquire('../boost-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub
    },
    'moment': momentStub
});

const resetStubs = () => testHelper.resetStubs(insertBoostStub);

const testStartTime = moment();
const testEndTime = moment().add(7, 'days');
const testMktingAdmin = uuid();

describe('*** UNIT TEST BOOSTS *** Validation and error checks for insert', () => {

    it('Rejects event without authorization', async () => {
        const resultOfCall = await handler.createBoost({ boostType: 'FRAUD' });
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403 });
    });

    it('Rejects all categories except referrals if user is ordinary role', async () => {
        const resultOfCall = await handler.createBoost(testHelper.wrapEvent({ boostTypeCategory: 'SIMPLE::TIME_LIMITED' }, uuid(), 'ORDINARY_USER' ));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403, body: 'Ordinary users cannot create boosts'});
    });

    it('Swallows an error and return its message', async () => {
        const resultOfCall = await handler.createBoost(testHelper.wrapEvent({ badObject: 'This is bad' }));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.have.property('statusCode', 500);
    });

});

describe('*** UNIT TEST BOOSTS *** General audience', () => {

    beforeEach(() => resetStubs());

    const mockRdsInstruction = {
        boostType: 'SIMPLE',
        boostCategory: 'TIME_LIMITED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        conditionClause: 'save_event_greater_than #{threshold}',
        conditionValue: 'threshold: 2000000',
        boostAudience: 'GENERAL',
        boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`
    };

    it('Happy path creating a time-limited simple, general boost', async () => {
        logger('About to create a simple boost');

        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const testNumberOfUsersInAudience = 100000;

        const testPersistedTime = moment();
        const persistenceResult = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: testNumberOfUsersInAudience
        };
        insertBoostStub.withArgs(mockRdsInstruction).resolves(persistenceResult);

        const testBodyOfEvent = {
            boostTypeCategory: 'SIMPLE::TIME_LIMITED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co'
            },
            endTimeMillis: testEndTime.valueOf(),
            conditionClause: 'save_event_greater_than #{threshold}',
            conditionValue: 'threshold: 2000000',
            boostAudience: 'GENERAL',
            boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`
        };

        const resultOfInstruction = await handler.createBoost(testHelper.wrapEvent(testBodyOfEvent, testMktingAdmin, 'SYSTEM_ADMIN'));

        const bodyOfResult = testHelper.standardOkayChecks(resultOfInstruction);
        expect(bodyOfResult).to.deep.equal(persistenceResult);
    });

});

describe('*** UNIT TEST BOOSTS *** Individual or limited users', () => {

    const referralWindowEnd = moment().add(3, 'months');
    const testReferringUser = uuid();
    const testReferredUser = uuid();

    const mockRdsInstruction = {
        boostType: 'REFERRAL',
        boostCategory: 'USER_CODE_USED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: referralWindowEnd,
        conditionClause: `save_completed_by #{${testReferredUser}}`,
        boostAudience: 'INDIVIDUAL',
        boostAudienceSelection: `whole_universe from #{'{"specific_users": ["${testReferringUser}","${testReferredUser}"]}'}`
    };

    it('Happy path inserting a referral-based individual boost', async () => {
        logger('About to create a referral based boost, for two users, ending at: ', referralWindowEnd);

        const testPersistedTime = moment();
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(referralWindowEnd.valueOf()).returns(referralWindowEnd);

        const expectedFromRds = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 2
        };
        insertBoostStub.withArgs(sinon.match(mockRdsInstruction)).resolves(expectedFromRds);

        const testBodyOfEvent = {
            boostTypeCategory: 'REFERRAL::USER_CODE_USED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co'
            },
            endTimeMillis: referralWindowEnd.valueOf(),
            conditionClause: `save_completed_by #{${testReferredUser}}`,
            boostAudience: 'INDIVIDUAL',
            boostAudienceSelection: `whole_universe from #{'{"specific_users": ["${testReferringUser}","${testReferredUser}"]}'}`
        };

        const resultOfInstruction = await handler.createBoost(testHelper.wrapEvent(testBodyOfEvent, testReferredUser, 'ORDINARY_USER'));
        // testHelper.logNestedMatches(mockRdsInstruction, insertBoostStub.getCall(0).args[0]);

        const bodyOfResult = testHelper.standardOkayChecks(resultOfInstruction);
        expect(bodyOfResult).to.deep.equal(expectedFromRds);
    });

});