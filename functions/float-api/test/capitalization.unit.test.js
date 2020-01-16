'use strict';

const logger = require('debug')('jupiter:capitalization:test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const helper = require('./test.helper');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const fetchLastLogStub = sinon.stub();
const fetchAccrualsStub = sinon.stub();
const addOrSubtractStub = sinon.stub();
const allocateNonUserStub = sinon.stub();
const allocateToUsersStub = sinon.stub();
const supercedeAccrualsStub = sinon.stub();

const fetchRecordsStub = sinon.stub();
const writeCsvFileStub = sinon.stub();

const fetchFloatConfigVarsStub = sinon.stub();

const BigNumber = require('bignumber.js');

const proxyquire = require('proxyquire');

const handler = proxyquire('../capitalization-handler', {
    './persistence/rds': {
        'fetchLastLog': fetchLastLogStub,
        'fetchAccrualsInPeriod': fetchAccrualsStub,
        'addOrSubtractFloat': addOrSubtractStub, 
        'allocateFloat': allocateNonUserStub,
        'allocateToUsers': allocateToUsersStub,
        'supercedeAccruals': supercedeAccrualsStub,
        'fetchRecordsRelatedToLog': fetchRecordsStub
    },
    './persistence/dynamodb': {
        'fetchConfigVarsForFloat': fetchFloatConfigVarsStub
    },
    './persistence/csvfile': {
        'writeAndUploadCsv': writeCsvFileStub
    },
    '@noCallThru': true
});

const testClientId = 'some-client-somewhere';
const testFloatId = 'primary-float';

const testLastLogTime = moment().subtract(1, 'month').startOf('month');
const testInterestTime = moment().subtract(1, 'day');

// some helper methods
const generateAccountResponse = () => {
    const amountAccrued = helper.randomInteger(1e7); // so each account accrued in range $0-1,000 (extra 4 for hundredth cent);
    const priorSettledBalance = amountAccrued * 100; // i.e., accruing 1% a month, just for now
    return {
        entityType: 'END_USER_ACCOUNT',
        accountId: uuid(),
        ownerUserId: uuid(),
        humanRef: `CDOE${helper.randomInteger(1000)}`, // so of the same rough form as human ref generally
        unit: 'HUNDREDTH_CENT',
        currency: 'USD',
        amountAccrued, 
        priorSettledBalance
    };
};

const generateEntityResponse = (entityId, entityType) => ({
    entityType,
    entityId,
    unit: 'HUNDREDTH_CENT',
    currency: 'USD',
    amountAccrued: helper.randomInteger(1e7)
});

const divideDistribution = (accrualMap, distributionPaid, bonusPoolId) => {
    const totalAccrued = Array.from(accrualMap.values()).reduce((sum, entry) => entry.amountAccrued + sum, 0);
    const remainderUnaccrued = distributionPaid - totalAccrued;
    
    const distributionMap = new Map();
    
    const accruedBn = new BigNumber(totalAccrued); // used below
    const remainderBn = new BigNumber(remainderUnaccrued);

    accrualMap.forEach((entityDetails, entityId) => {
        let amountToCredit = entityDetails.amountAccrued;
        if (remainderUnaccrued > 0) { // comes out of the bonus pool, which is the excess/overflow absorber
            const shareOfAllAccrual = new BigNumber(entityDetails.amountAccrued).dividedBy(accruedBn);
            const amountToAdd = remainderBn.times(shareOfAllAccrual);
            amountToCredit += amountToAdd.integerValue(BigNumber.ROUND_HALF_CEIL).toNumber();
        } else if (remainderUnaccrued < 0 && entityDetails.entityType === 'BONUS_POOL' && entityId === bonusPoolId) {
            amountToCredit += remainderUnaccrued;
        }
        const entityWithAmount = { ...entityDetails, amountToCredit };
        distributionMap.set(entityId, entityWithAmount);
    });

    // juuuuust in case one or two hundredths of a cent left over due to rounding
    const whollyAllocatedAmount = Array.from(distributionMap.values()).reduce((sum, value) => value.amountToCredit + sum, 0);
    if (whollyAllocatedAmount !== distributionPaid) {
        logger(`MATH ERROR : check : after division, still mismatch, distribution paid: ${distributionPaid}, wholly allocated: ${whollyAllocatedAmount}`);
        const currentBonusEntity = distributionMap.get(bonusPoolId);
        const adjustedBonusAmount = currentBonusEntity.amountToCredit + (distributionPaid - whollyAllocatedAmount);
        const revisedBonusEntry = { ...currentBonusEntity, amountToCredit: adjustedBonusAmount };
        distributionMap.set(bonusPoolId, revisedBonusEntry);
    }

    // logger('Test distribution map: ', distributionMap);
    return distributionMap;
};

describe('*** UNIT TEST CAPITALIZATION PREVIEW ***', () => {

    const testNumberAccounts = 100;
    const numberAccountsSampled = config.get('capitalization.preview.accountsToSample');
    
    const convertToPreview = (account, allocationEntity) => ({
        accountId: account.accountId,
        accountName: account.humanRef,
        unit: account.unit,
        currency: account.currency,
        priorBalance: account.priorSettledBalance,
        priorAccrued: account.amountAccrued,
        amountToCredit: allocationEntity.amountToCredit
    });

    beforeEach(() => helper.resetStubs(fetchLastLogStub, fetchAccrualsStub, fetchFloatConfigVarsStub));

    it('Happy path capitalization preview', async () => {
        const expectedFetchParams = { clientId: testClientId, floatId: testFloatId };
        
        const mockAccrualMap = new Map();
        const mockAccountsFromDb = Array(testNumberAccounts).fill().map(() => generateAccountResponse());
        const mockClientAccrued = generateEntityResponse(helper.commonFloatConfig.clientCoShareTracker, 'COMPANY_SHARE');
        const mockBonusAccrued = generateEntityResponse(helper.commonFloatConfig.bonusPoolTracker, 'BONUS_POOL');

        mockAccountsFromDb.forEach((account) => mockAccrualMap.set(account.accountId, account));
        mockAccrualMap.set(helper.commonFloatConfig.clientCoShareTracker, mockClientAccrued);
        mockAccrualMap.set(helper.commonFloatConfig.bonusPoolTracker, mockBonusAccrued);

        fetchLastLogStub.resolves({ clientId: testClientId, floatId: testFloatId, referenceTime: testLastLogTime, logType: 'CAPITALIZATION_EVENT' });
        fetchFloatConfigVarsStub.resolves(helper.commonFloatConfig);
        fetchAccrualsStub.resolves(mockAccrualMap);

        // logger('Accrual map: ', Array.from(mockAccrualMap.values()));
        const totalAccrued = Array.from(mockAccrualMap.values()).reduce((sum, entry) => entry.amountAccrued + sum, 0);
        logger('Total amount accrued: ', totalAccrued);
        const mockInterestPaid = Math.round(totalAccrued * (Math.random() * 0.2 + 1) / 100); // i.e., in the range of 20%, in cents
        logger('Constructing preview, interest paid: ', mockInterestPaid);
        const testEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            yieldPaid: mockInterestPaid,
            dateTimePaid: testInterestTime.valueOf(),
            unit: 'WHOLE_CENT',
            currency: 'USD'
        };

        const resultOfPreview = await handler.preview(testEvent);
        expect(resultOfPreview).to.exist;
        
        const expectedDistributionMap = divideDistribution(mockAccrualMap, mockInterestPaid * 100, helper.commonFloatConfig.bonusPoolTracker);
        const expectedPreviewAccounts = mockAccountsFromDb.map((account) => convertToPreview(account, expectedDistributionMap.get(account.accountId)));

        expect(resultOfPreview).to.have.property('numberAccountsToBeCredited', testNumberAccounts);

        const expectedAmountToClient = expectedDistributionMap.get(helper.commonFloatConfig.clientCoShareTracker).amountToCredit;
        expect(resultOfPreview).to.have.property('amountToCreditClient', expectedAmountToClient);
        const expectedAmountToBonusPool = expectedDistributionMap.get(helper.commonFloatConfig.bonusPoolTracker).amountToCredit;
        expect(resultOfPreview).to.have.property('amountToCreditBonusPool', expectedAmountToBonusPool);
        expect(resultOfPreview).to.have.property('excessOverPastAccrual', mockInterestPaid * 100 - totalAccrued);
        expect(resultOfPreview).to.have.property('unit', 'HUNDREDTH_CENT'); // i.e., our default
        expect(resultOfPreview).to.have.property('currency', 'USD');

        expect(resultOfPreview).to.have.property('sampleOfTransactions');
        const returnedSample = resultOfPreview.sampleOfTransactions;
        expect(returnedSample).to.be.an('array').of.length(Math.min(numberAccountsSampled, testNumberAccounts));
        returnedSample.forEach((sample) => {
            expect(expectedPreviewAccounts).to.deep.include(sample); // may be possible via a single contains call?
        });

        const expectedMoment = moment(testInterestTime.valueOf()); // otherwise Sinon fails on some irrelevant internals
        expect(fetchLastLogStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, logType: 'CAPITALIZATION_EVENT', endTime: expectedMoment });
        expect(fetchFloatConfigVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);

        const expectedAccrualParams = { ...expectedFetchParams, currency: 'USD', unit: 'HUNDREDTH_CENT', startTime: testLastLogTime, endTime: expectedMoment };
        expect(fetchAccrualsStub).to.have.been.calledOnceWithExactly(expectedAccrualParams);

    });

    it('Handles case where no prior capitalization, and directs from handler accordingly', async () => {
        const expectedFetchParams = { clientId: testClientId, floatId: testFloatId };

        const mockAccrualMap = new Map();
        const mockAccountsFromDb = Array(testNumberAccounts).fill().map(() => generateAccountResponse());
        const mockClientAccrued = generateEntityResponse(helper.commonFloatConfig.clientCoShareTracker, 'COMPANY_SHARE');
        const mockBonusAccrued = generateEntityResponse(helper.commonFloatConfig.bonusPoolTracker, 'BONUS_POOL');

        mockAccountsFromDb.forEach((account) => mockAccrualMap.set(account.accountId, account));
        mockAccrualMap.set(helper.commonFloatConfig.clientCoShareTracker, mockClientAccrued);
        mockAccrualMap.set(helper.commonFloatConfig.bonusPoolTracker, mockBonusAccrued);

        fetchLastLogStub.resolves(null);
        fetchFloatConfigVarsStub.resolves(helper.commonFloatConfig);
        fetchAccrualsStub.resolves(mockAccrualMap);

        const totalAccrued = Array.from(mockAccrualMap.values()).reduce((sum, entry) => entry.amountAccrued + sum, 0);
        const mockInterestPaid = Math.round(totalAccrued * (Math.random() * 0.2 + 1) / 100); // i.e., in the range of 20%, in cents
        const testEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            yieldPaid: mockInterestPaid,
            dateTimePaid: testInterestTime.valueOf(),
            unit: 'WHOLE_CENT',
            currency: 'USD'
        };

        // we check the detailed results on things above, then just check the accrual stub is called correctly
        const rawResult = await handler.handle({ operation: 'PREVIEW', parameters: testEvent });
        expect(rawResult).to.exist;
        expect(rawResult).to.have.property('statusCode', 200);

        const resultOfPreview = JSON.parse(rawResult.body);
        expect(resultOfPreview).to.exist;

        const expectedEndMoment = moment(testInterestTime.valueOf());
        expect(fetchLastLogStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, logType: 'CAPITALIZATION_EVENT', endTime: expectedEndMoment });
        expect(fetchFloatConfigVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        expect(fetchAccrualsStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, startTime: moment(0), endTime: expectedEndMoment, unit: 'HUNDREDTH_CENT', currency: 'USD' });
    });

    it('Handles http events properly', async () => {
        const testUserId = uuid();
        const expectedFetchParams = { clientId: testClientId, floatId: testFloatId };

        const mockAccrualMap = new Map();
        const mockAccountsFromDb = Array(testNumberAccounts).fill().map(() => generateAccountResponse());
        const mockClientAccrued = generateEntityResponse(helper.commonFloatConfig.clientCoShareTracker, 'COMPANY_SHARE');
        const mockBonusAccrued = generateEntityResponse(helper.commonFloatConfig.bonusPoolTracker, 'BONUS_POOL');

        mockAccountsFromDb.forEach((account) => mockAccrualMap.set(account.accountId, account));
        mockAccrualMap.set(helper.commonFloatConfig.clientCoShareTracker, mockClientAccrued);
        mockAccrualMap.set(helper.commonFloatConfig.bonusPoolTracker, mockBonusAccrued);

        fetchLastLogStub.resolves(null);
        fetchFloatConfigVarsStub.resolves(helper.commonFloatConfig);
        fetchAccrualsStub.resolves(mockAccrualMap);

        const totalAccrued = Array.from(mockAccrualMap.values()).reduce((sum, entry) => entry.amountAccrued + sum, 0);
        const mockInterestPaid = Math.round(totalAccrued * (Math.random() * 0.2 + 1) / 100); // i.e., in the range of 20%, in cents
        
        const testEvent = {
            httpMethod: 'POST',
            requestContext: { authorizer: { systemWideUserId: testUserId, role: 'SYSTEM_ADMIN' }},
            pathParameters: { proxy: 'preview' },
            body: JSON.stringify({
                clientId: testClientId,
                floatId: testFloatId,
                yieldPaid: mockInterestPaid,
                dateTimePaid: testInterestTime.valueOf(),
                unit: 'WHOLE_CENT',
                currency: 'USD'
            })
        };

        // we check the detailed results on things above, then just check the accrual stub is called correctly
        const rawResult = await handler.handle(testEvent);
        expect(rawResult).to.exist;
        expect(rawResult).to.have.property('statusCode', 200);

        const resultOfPreview = JSON.parse(rawResult.body);
        expect(resultOfPreview).to.exist;

        const expectedEndMoment = moment(testInterestTime.valueOf());
        expect(fetchLastLogStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, logType: 'CAPITALIZATION_EVENT', endTime: expectedEndMoment });
        expect(fetchFloatConfigVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        expect(fetchAccrualsStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, startTime: moment(0), endTime: expectedEndMoment, unit: 'HUNDREDTH_CENT', currency: 'USD' });
    });

    it('Fails on unauthorised access over http', async () => {
        const testUserId = uuid();

        const mockAccrualMap = new Map();
        const mockAccountsFromDb = Array(testNumberAccounts).fill().map(() => generateAccountResponse());
        const mockClientAccrued = generateEntityResponse(helper.commonFloatConfig.clientCoShareTracker, 'COMPANY_SHARE');
        const mockBonusAccrued = generateEntityResponse(helper.commonFloatConfig.bonusPoolTracker, 'BONUS_POOL');

        mockAccountsFromDb.forEach((account) => mockAccrualMap.set(account.accountId, account));
        mockAccrualMap.set(helper.commonFloatConfig.clientCoShareTracker, mockClientAccrued);
        mockAccrualMap.set(helper.commonFloatConfig.bonusPoolTracker, mockBonusAccrued);

        const totalAccrued = Array.from(mockAccrualMap.values()).reduce((sum, entry) => entry.amountAccrued + sum, 0);
        const mockInterestPaid = Math.round(totalAccrued * (Math.random() * 0.2 + 1) / 100);
        
        const testEvent = {
            httpMethod: 'POST',
            requestContext: { authorizer: { systemWideUserId: testUserId, role: 'ORDINARY_USER' }},
            pathParameters: { proxy: 'preview' },
            body: JSON.stringify({
                clientId: testClientId,
                floatId: testFloatId,
                yieldPaid: mockInterestPaid,
                dateTimePaid: testInterestTime.valueOf(),
                unit: 'WHOLE_CENT',
                currency: 'USD'
            })
        };

        const rawResult = await handler.handle(testEvent);
        expect(rawResult).to.exist;
        expect(rawResult).to.have.property('statusCode', 403);
        expect(rawResult).to.have.property('body', JSON.stringify('Unauthorized'));

        expect(fetchLastLogStub).to.have.not.been.called;
        expect(fetchFloatConfigVarsStub).to.have.not.been.called;
        expect(fetchAccrualsStub).to.have.not.been.called;
    });

    it('Fails on unsupperted operation', async () => {
        const mockAccrualMap = new Map();
        const mockAccountsFromDb = Array(testNumberAccounts).fill().map(() => generateAccountResponse());
        const mockClientAccrued = generateEntityResponse(helper.commonFloatConfig.clientCoShareTracker, 'COMPANY_SHARE');
        const mockBonusAccrued = generateEntityResponse(helper.commonFloatConfig.bonusPoolTracker, 'BONUS_POOL');

        mockAccountsFromDb.forEach((account) => mockAccrualMap.set(account.accountId, account));
        mockAccrualMap.set(helper.commonFloatConfig.clientCoShareTracker, mockClientAccrued);
        mockAccrualMap.set(helper.commonFloatConfig.bonusPoolTracker, mockBonusAccrued);

        const totalAccrued = Array.from(mockAccrualMap.values()).reduce((sum, entry) => entry.amountAccrued + sum, 0);
        const mockInterestPaid = Math.round(totalAccrued * (Math.random() * 0.2 + 1) / 100);
        const testEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            yieldPaid: mockInterestPaid,
            dateTimePaid: testInterestTime.valueOf(),
            unit: 'WHOLE_CENT',
            currency: 'USD'
        };

        const rawResult = await handler.handle({ operation: 'UNSUPPORTED', parameters: testEvent });
        logger('Result of capitalization:', rawResult);

        expect(rawResult).to.exist;
        expect(rawResult).to.have.property('statusCode', 500);

        const resultOfPreview = JSON.parse(rawResult.body);
        expect(resultOfPreview).to.exist;
        const expectedError = `Unsupported operation: event: ${JSON.stringify({ operation: 'UNSUPPORTED', parameters: testEvent })}`;
        expect(resultOfPreview).to.deep.equal(expectedError);

        expect(fetchLastLogStub).to.have.not.been.called;
        expect(fetchFloatConfigVarsStub).to.have.not.been.called;
        expect(fetchAccrualsStub).to.have.not.been.called;
    });

});

describe('*** UNIT TEST CAPITALIZATION CONDUCT ***', () => {

    const testNumberAccounts = 1;
    const mockFloatLogId = uuid();

    const convertToExpectedUserAlloc = (account, allocationEntity) => ({
        accountId: account.accountId,
        amount: allocationEntity.amountToCredit,
        unit: 'HUNDREDTH_CENT',
        currency: 'USD',
        allocType: 'CAPITALIZATION',
        allocState: 'SETTLED',
        settlementStatus: 'SETTLED',
        relatedEntityType: 'CAPITALIZATION_EVENT',
        relatedEntityId: mockFloatLogId
    });

    beforeEach(() => helper.resetStubs(fetchLastLogStub, fetchAccrualsStub, addOrSubtractStub, allocateNonUserStub, allocateToUsersStub, fetchFloatConfigVarsStub));

    it('Happy path capitalization confirmed', async () => {
        const expectedFetchParams = { clientId: testClientId, floatId: testFloatId };
        
        const mockAccrualMap = new Map();
        const mockAccountsFromDb = Array(testNumberAccounts).fill().map(() => generateAccountResponse());
        const mockClientAccrued = generateEntityResponse(helper.commonFloatConfig.clientCoShareTracker, 'COMPANY_SHARE');
        const mockBonusAccrued = generateEntityResponse(helper.commonFloatConfig.bonusPoolTracker, 'BONUS_POOL');

        mockAccountsFromDb.forEach((account) => mockAccrualMap.set(account.accountId, account));
        mockAccrualMap.set(helper.commonFloatConfig.clientCoShareTracker, mockClientAccrued);
        mockAccrualMap.set(helper.commonFloatConfig.bonusPoolTracker, mockBonusAccrued);

        const totalAccrued = Array.from(mockAccrualMap.values()).reduce((sum, entry) => entry.amountAccrued + sum, 0);
        const mockYieldPaid = Math.round(totalAccrued * (Math.random() * 0.2 + 1) / 100); // i.e., in the range of 20%, in cents

        const expectedDistributionMap = divideDistribution(mockAccrualMap, mockYieldPaid * 100, helper.commonFloatConfig.bonusPoolTracker);

        const testEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            yieldPaid: mockYieldPaid,
            dateTimePaid: testInterestTime.valueOf(),
            unit: 'WHOLE_CENT',
            currency: 'USD'
        };

        const expectedFloatAddSubtract = {
            clientId: testClientId,
            floatId: testFloatId,
            transactionType: 'CAPITALIZATION',
            amount: mockYieldPaid * 100,
            currency: 'USD',
            unit: 'HUNDREDTH_CENT',
            backingEntityType: 'CAPITALIZATION_EVENT',
            logType: 'CAPITALIZATION_EVENT',
            referenceTimeMillis: testInterestTime.valueOf()
        };

        const clientShareId = helper.commonFloatConfig.clientCoShareTracker;
        const clientAmount = expectedDistributionMap.get(clientShareId).amountToCredit;
        
        const bonusPoolId = helper.commonFloatConfig.bonusPoolTracker;
        const bonusAmount = expectedDistributionMap.get(bonusPoolId).amountToCredit;

        const expectedEntityAllocBase = { currency: 'USD', unit: 'HUNDREDTH_CENT', transactionType: 'CAPITALIZATION', transactionState: 'SETTLED' };
        expectedEntityAllocBase.relatedEntityType = 'CAPITALIZATION_EVENT';
        expectedEntityAllocBase.relatedEntityId = mockFloatLogId;
        expectedEntityAllocBase.logId = mockFloatLogId;

        const clientAlloc = { ...expectedEntityAllocBase, amount: clientAmount, allocatedToId: clientShareId, allocatedToType: 'COMPANY_SHARE', label: 'CLIENT' };
        const bonusAlloc = { ...expectedEntityAllocBase, amount: bonusAmount, allocatedToId: bonusPoolId, allocatedToType: 'BONUS_POOL', label: 'BONUS' };

        const expectedUserAllocs = mockAccountsFromDb.map((account) => convertToExpectedUserAlloc(account, 
                expectedDistributionMap.get(account.accountId)));
        const mockUserPerstResult = expectedUserAllocs.map((alloc) => ({ floatTxId: uuid(), accountTxId: uuid(), amount: alloc.amount }));

        fetchLastLogStub.resolves({ clientId: testClientId, floatId: testFloatId, referenceTime: testLastLogTime, logType: 'CAPITALIZATION_EVENT' });
        fetchFloatConfigVarsStub.resolves(helper.commonFloatConfig);
        fetchAccrualsStub.resolves(mockAccrualMap);
        
        addOrSubtractStub.resolves({ updatedBalance: 1e15 + mockYieldPaid, logId: mockFloatLogId });
        allocateNonUserStub.resolves({ 'BONUS': uuid(), 'CLIENT': uuid() });
        allocateToUsersStub.resolves(mockUserPerstResult);
        supercedeAccrualsStub.resolves({ result: 'SUCCESS' });

        const resultOfCapitalization = await handler.confirm(testEvent);
        expect(resultOfCapitalization).to.exist;
        
        // todo : probably want to send back all the records so can look at them
        expect(resultOfCapitalization).to.have.property('numberAccountsToBeCredited', testNumberAccounts);
        expect(resultOfCapitalization).to.have.property('amountToCreditClient', clientAmount);
        expect(resultOfCapitalization).to.have.property('amountToCreditBonusPool', bonusAmount);
        expect(resultOfCapitalization).to.have.property('excessOverPastAccrual', (mockYieldPaid * 100) - totalAccrued);
        expect(resultOfCapitalization).to.have.property('unit', 'HUNDREDTH_CENT');
        expect(resultOfCapitalization).to.have.property('currency', 'USD');

        // these to handle matches failing on weird deep differences in moment entities
        const expectedEndTime = moment(testInterestTime.valueOf());
        const expectedStartTime = testLastLogTime;

        expect(fetchLastLogStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, logType: 'CAPITALIZATION_EVENT', endTime: expectedEndTime });
        expect(fetchFloatConfigVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        
        const accArgs = { ...expectedFetchParams, startTime: expectedStartTime, endTime: expectedEndTime, unit: 'HUNDREDTH_CENT', currency: 'USD' };
        expect(fetchAccrualsStub).to.have.been.calledOnceWithExactly(accArgs);

        expect(addOrSubtractStub).to.have.been.calledOnceWithExactly(expectedFloatAddSubtract);

        expect(allocateNonUserStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId, [bonusAlloc, clientAlloc]);
        expect(allocateToUsersStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId, expectedUserAllocs);
        
        const expectedSupercedArgs = { startTime: expectedStartTime, endTime: expectedEndTime, clientId: testClientId, floatId: testFloatId, currency: 'USD' };
        expect(supercedeAccrualsStub).to.have.been.calledOnceWithExactly(expectedSupercedArgs, mockFloatLogId);
    });

    // it('Handles case where no prior capitalization', async () => {

    // });

});
