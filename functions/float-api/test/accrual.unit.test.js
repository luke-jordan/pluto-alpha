'use strict';

// process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:float:test');
const helper = require('./test.helper');

const uuid = require('uuid/v4');
const moment = require('moment');

const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);

const BigNumber = require('bignumber.js');

// using rather nice patterns from here: https://gist.github.com/StephaneTrebel/0c90fc435b6d93f297f52c72b3fddfb6
const rdsPath = './persistence/rds';
const dynamoPath = './persistence/dynamodb';

const createStubs = (customStubs) => ({
    [rdsPath]: customStubs[rdsPath],
    [dynamoPath]: customStubs[dynamoPath]
});

const common = require('./common');
const rds = require('../persistence/rds');
const dynamo = require('../persistence/dynamodb');
const constants = require('../constants');

let handler = require('../accrual-handler');

describe('Single apportionment operations', () => {

    it('Calculate bonus share properly, with random values, plus bonus share', () => {
        // note: e13 = 1 * 10^13 = 1 billion rand (1e9) in hundredths of cents
        const poolExamples = Array.from({length: 10}, () => Math.floor(Math.random() * 1e13));
        const shareExamples = Array.from({length: 3}, () => Math.random());
        shareExamples.push(common.testValueBonusPoolShare);
        shareExamples.push(common.testValueClientShare);

        poolExamples.forEach((pool) => {
            shareExamples.forEach((share) => {
                const expectedResult = new BigNumber(pool).times(new BigNumber(share)).integerValue(BigNumber.ROUND_HALF_UP).toNumber();
                const obtainedResult = handler.calculateShare(pool, share);
                expect(obtainedResult).to.exist;
                expect(obtainedResult).to.be.a('number');
                expect(obtainedResult).to.equal(expectedResult);
            });
        });
    });

    it('Throw an error if passed a bad pool value', () => {
        const badPool1 = 'some_pool_in_numbers!';
        const badPool2 = '1234';
        const badPool3 = 1234.5;

        const share = common.testValueBonusPoolShare;

        expect(handler.calculateShare.bind(handler, badPool1, share)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, badPool2, share)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, badPool3, share)).to.throw(TypeError);
    });

    it('Throw an error if passed a bad share', () => {
        const badShare1 = 'some_share_wrong';
        const badShare2 = 2.5;
        const badShare3 = -1;

        const pool = Math.floor(Math.random() * 1e11);

        expect(handler.calculateShare.bind(handler, pool, badShare1)).to.throw(TypeError);
        expect(handler.calculateShare.bind(handler, pool, badShare2)).to.throw(RangeError);
        expect(handler.calculateShare.bind(handler, pool, badShare3)).to.throw(RangeError);
    });

});

describe('Multiple apportionment operations', () => {

    it('Divide up the float with well-formed inputs', () => {
        const amountToAportion = Math.floor(Math.random() * 1e9); // somewhere in the region of R100
        
        const numberOfAccounts = 100000; // note this takes 162ms for 10k, and seems to scale linearly, so 1.3secs for 100k. 
        const numberList = Array.from(Array(numberOfAccounts).keys());
        
        const testAccountDict = new Map();
        // generate set of numbers representing accounts with ~R10k each
        const accountValues = numberList.map(() => Math.floor(Math.random() * 1e9));
        numberList.forEach((number) => testAccountDict.set(`test-account-${number}`, accountValues[number]));
        const sumOfAccounts = accountValues.reduce((cum, value) => cum + value, 0);

        // logger(`Generated account shares: ${JSON.stringify(testAccountDict)}`);
        logger(`Sum of values (in ZAR): ${sumOfAccounts / 1e4}, vs amount to apportion: ${amountToAportion / 1e4}`);
        
        const accountShares = accountValues.map((value) => (value * 10) / (sumOfAccounts * 10)); // note: FP may result in _above_ 100% (!)
        const sumOfPercent = accountShares.reduce((cum, value) => cum + value, 0);
        logger(`Percentage splits amount accounts sums to: ${sumOfPercent}`);
        
        const dividedUpAmounts = accountShares.map((share) => Math.round(share * amountToAportion));
        const sumCheck = dividedUpAmounts.reduce((cum, value) => cum + value, 0);
        const excess = amountToAportion - sumCheck; // this gets bigger as we have more accounts, though at rate of 2.85c in ~5 billion 
        logger(`Divided up amounts sum to: ${sumCheck}, vs original: ${amountToAportion}, excess: ${excess}`);
        
        const resultMap = new Map();
        numberList.forEach((number) => resultMap.set(`test-account-${number}`, dividedUpAmounts[number]));
        if (excess !== 0) { 
            resultMap.set('excess', excess);
        }

        logger('Calling apportionment operation, initiating core clock');
        const resultOfApportionment = handler.apportion(amountToAportion, testAccountDict);
        logger('Obtained result from apportionment');

        expect(resultOfApportionment).to.exist;
        expect(resultOfApportionment).to.be.a('map');

        // deep equal comparison on maps is _very_ slow, so pick a random set of numbers, and test with those
        const sampleSizeToCheck = Math.ceil(numberOfAccounts / 1000);
        logger('Going to sample ', sampleSizeToCheck, ' accounts');
        const randomSampleIndices = Array(numberOfAccounts).fill().map(() => Math.round(Math.random() * numberOfAccounts));
        randomSampleIndices.forEach((number) => {
            expect(resultOfApportionment.get(`test-account-${number}`)).to.equal(resultMap.get(`test-account-${number}`));
        });
        
        if (excess !== 0) {
            expect(resultOfApportionment.get('excess')).to.equal(resultMap.get('excess'));
        }
    }).timeout('4000'); // so we don't get spurious fails if the sample is taking a little time

    it('Check that error is thrown if passed non-integer account balances', async () => {
        const amountToAportion = Math.floor(Math.random() * 1e6);
        const accountDict = new Map();
        accountDict.set('test-account-1', 234.5);

        expect(handler.apportion.bind(handler, amountToAportion, accountDict)).to.throw(TypeError);
    });

});

describe('Primary allocation of inbound accrual lambda', () => {

    const fetchFloatConfigVarsStub = sinon.stub();

    const adjustFloatBalanceStub = sinon.stub();
    const allocateFloatBalanceStub = sinon.stub();
    const calculateFloatBalanceStub = sinon.stub();
    const obtainEntityBalanceStub = sinon.stub();
    const fetchRecordsRelatedToLog = sinon.stub();
    const writeCsvFileStub = sinon.stub();

    let allocationStub = sinon.stub();

    before(() => {        
        handler = proxyquire('../accrual-handler', {
            [dynamoPath]: { 
                fetchConfigVarsForFloat: fetchFloatConfigVarsStub 
            },
            [rdsPath]: { 
                addOrSubtractFloat: adjustFloatBalanceStub,
                allocateFloat: allocateFloatBalanceStub,
                calculateFloatBalance: calculateFloatBalanceStub,
                obtainPriorAllocationBalances: obtainEntityBalanceStub,
                fetchRecordsRelatedToLog: fetchRecordsRelatedToLog
            },
            './persistence/csvfile': {
                writeAndUploadCsv: writeCsvFileStub,
                '@noCallThru': true
            }
        });

        // withArgs(common.testValidClientId, common.testValidFloatId).
        allocationStub = sinon.stub(handler, 'allocate');
    });

    beforeEach(() => {
        helper.resetStubs(fetchFloatConfigVarsStub, adjustFloatBalanceStub, allocateFloatBalanceStub, calculateFloatBalanceStub, allocationStub);
    });

    it('Handles errors correctly (ie still exits)', async () => {
        fetchFloatConfigVarsStub.withArgs('some_client', 'some_float').throws(new Error('That went wrong!'));
        const expectedErrorReturn = await handler.accrue({ clientId: 'some_client', floatId: 'some_float'});
        expect(expectedErrorReturn).to.exist;
        expect(expectedErrorReturn).to.have.property('statusCode', 500);
    });

    it('Check initial accrual', async () => {
        const testBonusPoolId = helper.commonFloatConfig.bonusPoolTracker;
        const testClientCoId = helper.commonFloatConfig.clientCoShareTracker;

        // thousands of rand, in hundredths of a cent
        const amountAccrued = Math.floor(Math.random() * 1000 * 10000);  
        const testTxIds = Array(10).fill().map(() => uuid());
        const referenceTimeMillis = moment().valueOf();
        const testLogId = uuid();

        const accrualEvent = {
            clientId: common.testValidClientId,
            floatId: common.testValidFloatId,
            accrualAmount: amountAccrued,
            currency: 'ZAR',
            unit: constants.floatUnits.HUNDREDTH_CENT,
            backingEntityIdentifier: uuid(),
            referenceTimeMillis
        };

        const expectedFloatAdjustment = { ...accrualEvent, transactionType: 'ACCRUAL', backingEntityType: 'ACCRUAL_EVENT' };
        Reflect.deleteProperty(expectedFloatAdjustment, 'accrualAmount');
        expectedFloatAdjustment.amount = amountAccrued;
        expectedFloatAdjustment.logType = 'WHOLE_FLOAT_ACCRUAL';

        fetchFloatConfigVarsStub.withArgs(common.testValidClientId, common.testValidFloatId).resolves(helper.commonFloatConfig);
        calculateFloatBalanceStub.resolves({ balance: 100, unit: constants.floatUnits.HUNDREDTH_CENT });
        
        adjustFloatBalanceStub.withArgs(expectedFloatAdjustment).resolves({ updatedBalance: 100 + amountAccrued, logId: testLogId });

        obtainEntityBalanceStub.resolves(new Map([[testBonusPoolId, 10], [testClientCoId, 5]]));

        const expectedBonusAllocationAmount = Math.round(amountAccrued * common.testValueBonusPoolShare);
        const expectedClientCoAmount = Math.round(amountAccrued * common.testValueClientShare);

        const expectedGrossAmount = amountAccrued - expectedBonusAllocationAmount - expectedClientCoAmount;
        const expectedBonusShare = Math.round(0.1 * expectedGrossAmount);
        const expectedClientShare = Math.round(0.05 * expectedGrossAmount); 

        const expectedUserAmount = amountAccrued - expectedBonusAllocationAmount - expectedClientCoAmount - expectedBonusShare - expectedClientShare;

        const entityAllocation = (entityType, entityId, amount, label) => ({ 
            label,
            amount,
            currency: accrualEvent.currency, 
            unit: accrualEvent.unit,
            transactionType: 'ACCRUAL', 
            transactionState: 'SETTLED',
            allocatedToId: entityId,
            allocatedToType: entityType,
            relatedEntityId: accrualEvent.backingEntityIdentifier,
            relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,    
            logId: testLogId
        });
        
        const expectedBonusFeeAllocation = entityAllocation('BONUS_POOL', testBonusPoolId, expectedBonusAllocationAmount, 'BONUS_FEE');
        const expectedBonusShareAlloc = entityAllocation('BONUS_POOL', testBonusPoolId, expectedBonusShare, 'BONUS_SHARE');
        const expectedClientCoAllocation = entityAllocation('COMPANY_SHARE', testClientCoId, expectedClientCoAmount, 'CLIENT_FEE');
        const expectedClientShareAlloc = entityAllocation('COMPANY_SHARE', testClientCoId, expectedClientShare, 'CLIENT_SHARE');

        allocateFloatBalanceStub.resolves([{ 'BONUS_FEE': uuid() }, { 'CLIENT_FEE': uuid() }, { 'BONUS_SHARE': uuid() }, { 'CLIENT_SHARE': uuid() }]);

        const userAllocEvent = {
            clientId: common.testValidClientId, floatId: common.testValidFloatId, 
            totalAmount: expectedUserAmount,
            currency: 'ZAR',
            unit: accrualEvent.unit,
            transactionType: 'ACCRUAL',
            transactionState: 'SETTLED',
            backingEntityType: constants.entityTypes.ACCRUAL_EVENT,
            backingEntityIdentifier: accrualEvent.backingEntityIdentifier,
            bonusPoolIdForExcess: common.testValueBonusPoolTracker,
            logId: testLogId
        };

        // we test bonus allocation of any fractional amount in the tests below, so here just set to none
        allocationStub.withArgs(userAllocEvent).resolves({ allocationRecords: testTxIds, bonusAllocation: { } });
        
        // and last we test the record keeping
        const mockRecords = [{ 'first_column': 'some-id', 'second_column': 60 }, { 'first_column': 'another-id', 'second_column': 80 }];
        fetchRecordsRelatedToLog.resolves(mockRecords);
        writeCsvFileStub.resolves('s3://bucket/somekey');
        
        const response = await handler.accrue(accrualEvent, { });

        // expect the config variables to be fetched
        expect(fetchFloatConfigVarsStub).to.have.been.calledOnce;
        
        // expect the float to have its balance adjusted upward
        expect(adjustFloatBalanceStub).to.have.been.calledOnce;
        expect(adjustFloatBalanceStub).to.have.been.calledWith(expectedFloatAdjustment);

        // expect the bonus and company shares to be allocated
        expect(allocateFloatBalanceStub).to.have.been.calledOnce;
        // helper.logNestedMatches(expectedClientCoAllocation, allocateFloatBalanceStub.getCall(0).args[2][1]);
        expect(allocateFloatBalanceStub).to.have.been.calledOnceWithExactly(common.testValidClientId, common.testValidFloatId, 
                [expectedBonusFeeAllocation, expectedClientCoAllocation, expectedBonusShareAlloc, expectedClientShareAlloc]);

        // for now we are going to call this method directly; in future will be easy to change it into a queue or async lambda invocation
        expect(allocationStub).to.have.been.calledOnce;
        expect(allocationStub).to.have.been.calledWithExactly(userAllocEvent);
        // expect the lambda to then return the correct, well formatted response
        expect(response.statusCode).to.equal(200);
        expect(response.body).to.exist;
        
        const responseEntity = JSON.parse(response.body);
        expect(responseEntity.entityAllocations).to.exist;
        expect(responseEntity.entityAllocations).to.have.keys(['BONUS_FEE', 'CLIENT_FEE', 'BONUS_SHARE', 'CLIENT_SHARE']);
        const clientShare = responseEntity.entityAllocations['CLIENT_FEE']['amount'];
        expect(clientShare).to.be.lessThan(amountAccrued);

        logger('New balance : ', responseEntity);
        expect(responseEntity.newBalance).to.be.at.least(amountAccrued);
        expect(responseEntity.entityAllocations['BONUS_FEE']['amount']).to.be.lessThan(amountAccrued - clientShare);

        expect(responseEntity.userAllocationTransactions).to.deep.equal({ allocationRecords: testTxIds, bonusAllocation: { } });
    });

});

describe('Primary allocation of unallocated float lamdba', () => {

    let obtainAccountBalancesStub = { };
    let allocateFloatStub = { };
    let allocateToUsersStub = { };
    let apportionStub = { };
    let fetchFloatConfigVarsStub = { };

    before(() => {
        obtainAccountBalancesStub = sinon.stub(rds, 'obtainAllAccountsWithPriorAllocations');
        allocateFloatStub = sinon.stub(rds, 'allocateFloat');
        allocateToUsersStub = sinon.stub(rds, 'allocateToUsers');

        fetchFloatConfigVarsStub = sinon.stub(dynamo, 'fetchConfigVarsForFloat');

        handler = proxyquire('../accrual-handler', createStubs({
            [rdsPath]: { 
                obtainAllAccountsWithPriorAllocations: obtainAccountBalancesStub,
                allocateFloat: allocateFloatStub,
                allocateToUsers: allocateToUsersStub
            },
            [dynamoPath]: {
                fetchConfigVarsForFloat: fetchFloatConfigVarsStub
            }
        }));

        apportionStub = sinon.stub(handler, 'apportion');
    });

    after(() => {
        rds.obtainAllAccountsWithPriorAllocations.restore();
        rds.allocateToUsers.restore();
    });

    afterEach(() => {
        obtainAccountBalancesStub.reset();
        allocateToUsersStub.reset();
        handler.apportion.restore();
    });

    it('Happy path, when passed a balance to divide', async () => {
        const numberAccounts = 10;
        const amountToAllocate = 1000 * 100 * 100; // allocating R1k in interest

        const mockLogId = uuid();

        // comes in from scheduled job
        const incomingEvent = {
            clientId: common.testValidClientId, 
            floatId: common.testValidFloatId, 
            totalAmount: amountToAllocate,
            currency: 'ZAR',
            unit: constants.floatUnits.HUNDREDTH_CENT,
            backingEntityType: constants.entityTypes.ACCRUAL_EVENT,
            backingEntityIdentifier: uuid(),
            bonusPoolIdForExcess: common.testValueBonusPoolTracker,
            logId: mockLogId
        };


        const existingBalances = new Map();
        // this will ensure the total balance is much larger than the amount to allocate, but roughly equal to order of magnitude larger with number accounts
        Array(numberAccounts).fill().forEach(() => existingBalances.set(uuid(), Math.round(Math.random() * amountToAllocate)));
        
        // this gets tested above, and has a whole bunch of logic that would be silly to just mimc here, but we need to ensure excess is tested
        // so we do not make sure that the allocation is accurate (i.e., totals), we just construct a map and add excess to
        const apportionedBalances = new Map();
        const averagePortion = amountToAllocate / numberAccounts;
        for (const accountId of existingBalances.keys()) {
            apportionedBalances.set(accountId, Math.round((Math.random() + 0.5) * averagePortion));
        }
        apportionedBalances.set(constants.EXCESSS_KEY, -75);

        fetchFloatConfigVarsStub.withArgs(common.testValidClientId, common.testValidFloatId).resolves({ bonusPoolTracker: common.testValueBonusPoolTracker });
        
        const bonuxTxAlloc = {
            label: 'BONUS',
            amount: -75,
            currency: incomingEvent.currency,
            unit: incomingEvent.unit,
            transactionType: 'ACCRUAL',
            transactionState: 'SETTLED',
            allocatedToType: constants.entityTypes.BONUS_POOL,
            allocatedToId: common.testValueBonusPoolTracker,
            relatedEntityType: incomingEvent.backingEntityType,
            relatedEntityId: incomingEvent.backingEntityIdentifier,
            logId: mockLogId
        };
        const bonusTxId = uuid();

        const expectedUserAllocsToRds = [];
        const mockResultFromRds = [];
        for (const accountId of existingBalances.keys()) {
            const userAllocInstruction = {
                accountId: accountId,
                amount: apportionedBalances.get(accountId),
                currency: 'ZAR',
                unit: incomingEvent.unit,
                allocType: 'ACCRUAL',
                allocState: 'SETTLED',
                relatedEntityType: incomingEvent.backingEntityType,
                relatedEntityId: incomingEvent.backingEntityIdentifier,
                logId: mockLogId
            };
            expectedUserAllocsToRds.push(userAllocInstruction);
            mockResultFromRds.push({ floatTxId: uuid(), accountTxId: uuid(), amount: apportionedBalances.get(accountId) });
        }
        
        // only one call to each and arguments are more efficiently (for debugging) tested below
        apportionStub.returns(apportionedBalances);
        obtainAccountBalancesStub.resolves(existingBalances);
        allocateFloatStub.resolves({ 'BONUS': bonusTxId });
        allocateToUsersStub.resolves(mockResultFromRds);
        
        const allocationResult = await handler.allocate(incomingEvent, { });
        expect(allocationResult).to.exist;
        
        const expectedBody = { allocationRecords: mockResultFromRds, bonusAllocation: { 'BONUS': bonusTxId, amount: -75 } };
        expect(allocationResult).to.deep.equal(expectedBody);
        
        expect(apportionStub).to.have.been.calledOnceWithExactly(amountToAllocate, existingBalances, true);
        expect(obtainAccountBalancesStub).to.have.been.calledOnceWithExactly(common.testValidFloatId, 'ZAR', constants.entityTypes.END_USER_ACCOUNT);
        expect(allocateFloatStub).to.have.been.calledOnceWithExactly(common.testValidClientId, common.testValidFloatId, [bonuxTxAlloc]);
        
        expect(allocateToUsersStub).to.have.been.calledOnceWithExactly(common.testValidClientId, common.testValidFloatId, expectedUserAllocsToRds);
    
    }).timeout(3000);

});
