'use strict';

const logger = require('debug')('jupiter:boosts:test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const decamelize = require('decamelize');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

const findMsgInstructStub = sinon.stub();
const findUserIdsStub = sinon.stub();

const insertBoostStub = sinon.stub();
const findBoostStub = sinon.stub();
const findAccountsStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const fetchUncreatedBoostsStub = sinon.stub();

const redemptionHandlerStub = sinon.stub();

const queryStub = sinon.stub();
const multiTableStub = sinon.stub();

const uuidStub = sinon.stub();
const momentStub = sinon.stub();

const publishStub = sinon.stub();
const publishMultiStub = sinon.stub();

const lamdbaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.largeMultiTableInsert = multiTableStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const rds = proxyquire('../persistence/rds.boost', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub,
    '@noCallThru': true
});

const boostEventHandler = proxyquire('../boost-event-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub,
        'findBoost': findBoostStub,
        'findAccountsForBoost': findAccountsStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'fetchUncreatedActiveBoostsForAccount': fetchUncreatedBoostsStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub
    },
    'moment': momentStub,
    '@noCallThru': true
});

const boostCreateHandler = proxyquire('../boost-create-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub,
        'findBoost': findBoostStub,
        'findAccountsForBoost': findAccountsStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'findMsgInstructionByFlag': findMsgInstructStub,
        'findUserIdsForAccounts': findUserIdsStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'publish-common': {
        'publishUserEvent': publishStub,
        'publishMultiUserEvent': publishMultiStub
    },
    'moment': momentStub,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(
    insertBoostStub, findBoostStub, findAccountsStub, 
    updateBoostAccountStub, publishStub, fetchUncreatedBoostsStub,
    lamdbaInvokeStub, publishMultiStub, queryStub, multiTableStub, uuidStub
);

describe('*** UNIT TEST BOOSTS *** Individual or limited users', () => {
    const testStartTime = moment();
    const testAudienceId = uuid();
    
    const testClientId = 'some_client_co';
    const mockBoostSource = { bonusPoolId: 'primary_bonus_pool', clientId: testClientId, floatId: 'primary_cash' };

    const referralWindowEnd = moment().add(3, 'months');
    
    const testReferringUser = uuid();
    const testReferredUser = uuid();

    // IDs for message templates for referrer and referred
    const testReferringMsgId = uuid();
    const testReferredMsgId = uuid();

    const testCreatingUserId = uuid();

    // `whole_universe from #{'{"specific_accounts": ["${testReferringUser}","${testReferredUser}"]}'}`
    const mockBoostToFromPersistence = {
        creatingUserId: testCreatingUserId,
        label: 'Referral::Luke::Avish',
        boostType: 'REFERRAL',
        boostCategory: 'USER_CODE_USED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostBudget: 10000000,
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: referralWindowEnd,
        statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
        boostAudienceType: 'INDIVIDUAL',
        audienceId: testAudienceId,
        defaultStatus: 'PENDING',
        messageInstructionIds: [
            { accountId: testReferringUser, msgInstructionId: testReferringMsgId, status: 'REDEEMED' }, 
            { accountId: testReferredUser, msgInstructionId: testReferredMsgId, status: 'REDEEMED' }
        ],
        flags: ['REDEEM_ALL_AT_ONCE']
    };

    it('Happy path inserting a referral-based individual boost', async () => {
        const testPersistedTime = moment();
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(referralWindowEnd.valueOf()).returns(referralWindowEnd);

        const testCreatedAudienceId = uuid();
        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ 
            body: JSON.stringify({ audienceId: testCreatedAudienceId })
        })})});

        findMsgInstructStub.withArgs('REFERRAL::REDEEMED::REFERRER').resolves(testReferringMsgId);
        findMsgInstructStub.withArgs('REFERRAL::REDEEMED::REFERRED').resolves(testReferredMsgId);

        const expectedFromRds = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 2,
            accountIds: [testReferringUser, testReferredUser]
        };

        insertBoostStub.resolves(expectedFromRds);

        const testBodyOfEvent = {
            creatingUserId: testCreatingUserId,
            label: 'Referral::Luke::Avish',
            boostTypeCategory: 'REFERRAL::USER_CODE_USED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: '10000000::HUNDREDTH_CENT::USD',
            boostSource: mockBoostSource,
            endTimeMillis: referralWindowEnd.valueOf(),
            boostAudienceType: 'INDIVIDUAL',
            boostAudienceSelection: {
                table: config.get('tables.accountLedger'),
                conditions: [{ op: 'in', prop: 'account_id', value: `${testReferringUser}, ${testReferredUser}` }]
            },
            initialStatus: 'PENDING',
            statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
            messageInstructionFlags: {
                'REDEEMED': [
                    { accountId: testReferringUser, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRER' }, 
                    { accountId: testReferredUser, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRED' }
                ]
            }
        };

        findUserIdsStub.resolves(['user-id-1', 'user-id-2']);

        const resultOfInstruction = await boostCreateHandler.createBoost(testBodyOfEvent);
        expect(resultOfInstruction).to.deep.equal(expectedFromRds);

        const expectedAudiencePayload = {
            operation: 'create',
            params: {
                clientId: testClientId,
                creatingUserId: testCreatingUserId,
                isDynamic: false,
                conditions: testBodyOfEvent.boostAudienceSelection.conditions
            }
        };
        const wrappedInvoke = testHelper.wrapLambdaInvoc('audience_selection', false, expectedAudiencePayload);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(wrappedInvoke);

        // const objectToRds = insertBoostStub.getCall(0).args[0];
        // logger('Sent to RDS: ', objectToRds);
        const expectedBoost = { ...mockBoostToFromPersistence };
        expectedBoost.audienceId = testCreatedAudienceId;
        expect(insertBoostStub).to.have.been.calledWithExactly(expectedBoost);

        expect(findUserIdsStub).to.have.been.calledWithExactly([testReferringUser, testReferredUser]);
        const expectedBoostAmount = { boostAmount: 100000, boostUnit: 'HUNDREDTH_CENT', boostCurrency: 'USD' };

        const expectedUserLogOptions = {
            initiator: testCreatingUserId,
            context: {
                boostType: 'REFERRAL', boostCategory: 'USER_CODE_USED', boostId: expectedFromRds.boostId, ...expectedBoostAmount,
                boostStartTime: testStartTime.valueOf(), boostEndTime: referralWindowEnd.valueOf(), gameParams: undefined,
                rewardParameters: undefined, statusConditions: mockBoostToFromPersistence.statusConditions
            }
        };
        expect(publishMultiStub).to.have.been.calledWithExactly(['user-id-1', 'user-id-2'], 'BOOST_CREATED_REFERRAL', expectedUserLogOptions);
    });
});

describe('*** UNIT TEST BOOST PROCESSING *** Individual or limited users', () => {
    const expectedStatusCheck = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING'];

    const testStartTime = moment();
    const referralWindowEnd = moment().add(3, 'months');
    const timeSaveCompleted = moment();
    
    const testReferringUser = uuid();
    const testReferredUser = uuid();

    // IDs for message templates for referrer and referred
    const testReferringMsgId = uuid();
    const testReferredMsgId = uuid();

    const mockBoostToFromPersistence = {
        creatingUserId: uuid(),
        boostType: 'REFERRAL',
        boostCategory: 'USER_CODE_USED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: referralWindowEnd,
        statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
        boostAudience: 'INDIVIDUAL',
        boostAudienceSelection: `whole_universe from #{'{"specific_accounts": ["${testReferringUser}","${testReferredUser}"]}'}`,
        defaultStatus: 'PENDING',
        messageInstructions: [
            { accountId: testReferringUser, msgInstructionId: testReferringMsgId, status: 'REDEEMED' }, 
            { accountId: testReferredUser, msgInstructionId: testReferredMsgId, status: 'REDEEMED' }
        ],
        flags: ['REDEEM_ALL_AT_ONCE']
    };

    // note: these are not originally from SNS, hence only single-wrapper
    const wrapEventAsSqs = (event) => testHelper.composeSqsBatch([event]);

    beforeEach(() => (resetStubs()));

    it('Happy path closing out a referral after referred user adds cash', async () => {
        logger('Testing instruction received to redeem the boost, as a result of referred user making first save');
        const testUserId = uuid();
        const testOriginalUserId = uuid(); // i.e., referrer

        const testBoostId = uuid();
        const testSavingTxId = uuid();

        // this will be invoked only by other lambdas, never directly, and is likely to involve just a user ID
        const testEvent = {
            accountId: testReferredUser,
            eventType: 'SAVING_EVENT_COMPLETED',
            timeInMillis: timeSaveCompleted.valueOf(),
            eventContext: {
                transactionId: testSavingTxId,
                savedAmount: '5000000::HUNDREDTH_CENT::USD',
                firstSave: true
            }
        };

        const boostFromPersistence = JSON.parse(JSON.stringify(mockBoostToFromPersistence));
        boostFromPersistence.boostId = testBoostId;

        // first, see if this account has offered or pending boosts against it
        const expectedKey = { accountId: [testReferredUser], boostStatus: expectedStatusCheck, active: true, underBudgetOnly: true };
        findBoostStub.withArgs(expectedKey).resolves([boostFromPersistence]);
        fetchUncreatedBoostsStub.resolves([]);
        
        // then we will have to do a condition check, after which decide that the boost has been redeemed
        // and get the accounts that are affected by the redemption
        findAccountsStub.withArgs({ boostIds: [testBoostId], status: expectedStatusCheck }).resolves([{ 
            boostId: testBoostId,
            accountUserMap: {
                [testReferredUser]: { userId: testUserId, status: 'PENDING' },
                [testReferringUser]: { userId: testOriginalUserId, status: 'PENDING' }
            }
        }]);

        // then we update the boost statuses
        const updateProcessedTime = moment();
        const testUpdateInstruction = [{
            boostId: testBoostId,
            accountIds: [testReferredUser, testReferringUser],
            newStatus: 'REDEEMED',
            stillActive: false,
            logType: 'STATUS_CHANGE',
            logContext: { newStatus: 'REDEEMED', boostAmount: 100000, transactionId: uuid() }
        }];
        // logger('Expecting update instructions: ', testUpdateInstruction);
        updateBoostAccountStub.withArgs(testUpdateInstruction).resolves([{ boostId: testBoostId, updatedTime: updateProcessedTime }]);
        
        // then we hand over to the boost redemption handler, which does a lot of stuff
        redemptionHandlerStub.resolves({ [testBoostId]: { result: 'SUCCESS' }});

        const resultOfEventRecord = await boostEventHandler.handleBatchOfQueuedEvents(wrapEventAsSqs(testEvent));
        logger('Result of record: ', resultOfEventRecord);

        expect(resultOfEventRecord).to.exist;
        // expect(publishStub).to.be.calledWithExactly(testUserId, 'REFERRAL_REDEEMED', publishOptions);
        // expect(publishStub).to.be.calledWithExactly(testOriginalUserId, 'REFERRAL_REDEEMED', publishOptions);
    });

});

describe('*** UNIT TEST BOOSTS RDS *** Inserting boost instruction and boost-user records', () => {
    const boostTable = config.get('tables.boostTable');
    const boostUserTable = config.get('tables.boostAccountJoinTable');

    const testBoostId = uuid();
    const testAudienceId = uuid();
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };
    const testRedemptionMsgs = [{ accountId: 'ALL', msgInstructionId: uuid() }];

    const standardBoostKeys = ['boostId', 'creatingUserId', 'label', 'startTime', 'endTime', 'boostType', 'boostCategory', 'boostAmount', 
        'boostBudget', 'boostRedeemed', 'boostUnit', 'boostCurrency', 'fromBonusPoolId', 'fromFloatId', 'forClientId', 
        'boostAudienceType', 'audienceId', 'initialStatus', 'statusConditions', 'messageInstructionIds', 'flags'];
    const boostUserKeys = ['boostId', 'accountId', 'boostStatus'];
    
    const extractColumnTemplate = (keys) => keys.map((key) => `$\{${key}}`).join(', ');
    const extractQueryClause = (keys) => keys.map((key) => decamelize(key)).join(', ');

    beforeEach(() => (resetStubs()));

    it('Insert a referral code and construct the two entry logs', async () => {
        const testBoostStartTime = moment();
        const testBoostEndTime = moment();

        const testInstructionId = uuid();
        const testCreatingUserId = uuid();
        const testReferringAccountId = uuid();
        const testReferredUserAccountId = uuid();

        const relevantUsers = [testReferringAccountId, testReferredUserAccountId];

        // first, obtain the audience & generate a UID
        queryStub.onFirstCall().resolves([{ 'account_id': testReferringAccountId }, { 'account_id': testReferredUserAccountId }]);
        uuidStub.onFirstCall().returns(testBoostId);

        // then, construct the simultaneous insert operations
        // first, the instruction to insert the overall boost
        const expectedFirstQuery = `insert into ${boostTable} (${extractQueryClause(standardBoostKeys)}) values %L returning boost_id, creation_time`;
        const expectedFirstRow = {
            boostId: testBoostId,
            label: 'Referral Code Boost!',
            creatingUserId: testCreatingUserId,
            startTime: testBoostStartTime.format(),
            endTime: testBoostEndTime.format(),
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostBudget: 200000, // i.e., twice the amount
            boostRedeemed: 0,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            fromFloatId: 'primary_float',
            forClientId: 'some_client_co',
            boostAudienceType: 'INDIVIDUAL',
            audienceId: testAudienceId,
            initialStatus: 'PENDING',
            statusConditions: testStatusCondition,
            messageInstructionIds: { instructions: [testInstructionId, testInstructionId] },
            flags: ['TEST_FLAG']
        };
        const insertFirstDef = { query: expectedFirstQuery, columnTemplate: extractColumnTemplate(standardBoostKeys), rows: [expectedFirstRow]};

        // then, the instruction for the user - boost join entries
        const expectedSecondQuery = `insert into ${boostUserTable} (${extractQueryClause(boostUserKeys)}) values %L returning insertion_id, creation_time`;
        const expectedJoinTableRows = [
            { boostId: testBoostId, accountId: testReferringAccountId, boostStatus: 'PENDING' },
            { boostId: testBoostId, accountId: testReferredUserAccountId, boostStatus: 'PENDING' }
        ];
        const expectedSecondDef = { query: expectedSecondQuery, columnTemplate: extractColumnTemplate(boostUserKeys), rows: expectedJoinTableRows};

        // then transact them
        const insertionTime = moment();
        // this is not great but Sinon matching is just the worst thing in the world and is failing abysmally on complex matches, hence
        multiTableStub.resolves([
            [{ 'boost_id': testBoostId, 'creation_time': insertionTime.format() }],
            [{ 'insertion_id': 100, 'creation_time': moment().format() }, { 'insertion_id': 101, 'creation_time': moment().format() }]
        ]);

        const testInstruction = {
            creatingUserId: testCreatingUserId,
            label: 'Referral Code Boost!',
            boostType: 'REFERRAL',
            boostCategory: 'USER_CODE_USED',
            boostAmount: 100000,
            boostBudget: 200000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            fromBonusPoolId: 'primary_bonus_pool',
            forClientId: 'some_client_co',
            fromFloatId: 'primary_float',
            boostStartTime: testBoostStartTime,
            boostEndTime: testBoostEndTime,
            statusConditions: testStatusCondition,
            boostAudienceType: 'INDIVIDUAL',
            audienceId: testAudienceId,
            redemptionMsgInstructions: testRedemptionMsgs,
            messageInstructionIds: [testInstructionId, testInstructionId],
            defaultStatus: 'PENDING',
            flags: ['TEST_FLAG']
        };

        const resultOfInsertion = await rds.insertBoost(testInstruction);

        // then respond with the number of users, and the boost ID itself, along with when it was persisted (given psql limitations, to nearest second)
        const expectedMillis = insertionTime.startOf('second').valueOf();
        expect(resultOfInsertion).to.exist;
        expect(resultOfInsertion).to.have.property('boostId', testBoostId);
        expect(resultOfInsertion).to.have.property('persistedTimeMillis', expectedMillis);
        expect(resultOfInsertion).to.have.property('numberOfUsersEligible', relevantUsers.length);

        const expectedAccountIds = [testReferringAccountId, testReferredUserAccountId]; // property match fails spuriously 
        expect(resultOfInsertion.accountIds).to.deep.equal(expectedAccountIds);

        const expectedSelectQuery = `select account_id from ${config.get('tables.audienceJoinTable')} where audience_id = $1 and active = $2`;
        expect(queryStub).to.have.been.calledOnceWithExactly(expectedSelectQuery, [testAudienceId, true]);

        expect(multiTableStub).to.have.been.calledOnce;
        const multiTableArgs = multiTableStub.getCall(0).args[0];
        expect(multiTableArgs[1]).to.deep.equal(expectedSecondDef);
        expect(multiTableArgs[0]).to.deep.equal(insertFirstDef);
    });

});
