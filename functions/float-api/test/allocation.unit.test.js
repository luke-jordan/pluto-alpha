'use strict';

const logger = require('debug')('jupiter:float:test');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

let apportionStub = sinon.stub();

const obtainAccountBalancesStub = sinon.stub();
const allocateFloatBalanceStub = sinon.stub();
const allocateToUsersStub = sinon.stub();

const mockRds = {
    obtainAllAccountsWithPriorAllocations: obtainAccountBalancesStub,
    allocateFloat: allocateFloatBalanceStub,
    allocateToUsers: allocateToUsersStub
};

const allocationHelper = require('../allocation-helper');

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
        const resultOfApportionment = allocationHelper.apportion(amountToAportion, testAccountDict);
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

        expect(allocationHelper.apportion.bind(allocationHelper, amountToAportion, accountDict)).to.throw(TypeError);
    });

});

describe('Primary allocation calculation to all float users of some amount', () => {

    before(() => {
        apportionStub = sinon.stub(allocationHelper, 'apportion');
    });

    beforeEach(() => {
        allocateFloatBalanceStub.reset();
        obtainAccountBalancesStub.reset();
        allocateToUsersStub.reset();
    });

    after(() => {
        allocationHelper.apportion.restore();
    });

    it('Happy path, when passed a balance to divide', async () => {
        const numberAccounts = 10000;
        const amountToAllocate = 1000 * 100 * 100; // allocating R1k in interest

        const mockLogId = uuid();

        // comes in from scheduled job
        const incomingEvent = {
            clientId: 'some_client_id', 
            floatId: 'some_float_id', 
            totalAmount: amountToAllocate,
            currency: 'ZAR',
            unit: 'HUNDREDTH_CENT',
            backingEntityType: 'ACCRUAL_EVENT',
            backingEntityIdentifier: uuid(),
            bonusPoolIdForExcess: 'some_bonus_pool',
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
        apportionedBalances.set('excess', -75);
        
        const bonuxTxAlloc = {
            label: 'BONUS',
            amount: -75,
            currency: incomingEvent.currency,
            unit: incomingEvent.unit,
            transactionType: 'ACCRUAL',
            transactionState: 'SETTLED',
            allocatedToType: 'BONUS_POOL',
            allocatedToId: 'some_bonus_pool',
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
        allocateFloatBalanceStub.resolves({ 'BONUS': bonusTxId });
        allocateToUsersStub.resolves(mockResultFromRds);
        
        const allocationResult = await allocationHelper.allocate(incomingEvent, mockRds);
        expect(allocationResult).to.exist;
        
        const expectedBody = { 
            allocationRecords: mockResultFromRds, 
            bonusAllocation: { 'BONUS': bonusTxId, amount: -75 },
            priorAllocationMap: existingBalances 
        };
        expect(allocationResult).to.deep.equal(expectedBody);
        
        expect(apportionStub).to.have.been.calledOnceWithExactly(amountToAllocate, existingBalances, true);
        expect(obtainAccountBalancesStub).to.have.been.calledOnceWithExactly('some_float_id', 'ZAR', 'END_USER_ACCOUNT');
        expect(allocateFloatBalanceStub).to.have.been.calledOnceWithExactly('some_client_id', 'some_float_id', [bonuxTxAlloc]);
        
        expect(allocateToUsersStub).to.have.been.calledOnceWithExactly('some_client_id', 'some_float_id', expectedUserAllocsToRds);
    
    });

});
