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
        'supercedeAccruals': supercedeAccrualsStub
    },
    './persistence/dynamodb': {
        'fetchConfigVarsForFloat': fetchFloatConfigVarsStub
    },
    '@noCallThru': true
});

const testClientId = 'some-client-somewhere';
const testFloatId = 'primary-float';

const testLastLogTime = moment().subtract(1, 'month').startOf('month');
const testInterestTime = moment().subtract(1, 'day');

// some helper methods
const generateAccountResponse = () => {
    const amountAccrued = Math.floor(Math.random() * 1e7); // so each account accrued in range $0-1,000 (extra 4 for hundredth cent);
    const priorSettledBalance = amountAccrued * 100; // i.e., accruing 1% a month, just for now
    return {
        entityType: 'END_USER_ACCOUNT',
        accountId: uuid(),
        ownerUserId: uuid(),
        humanRef: `CDOE${Math.floor(Math.random() * 1000)}`, // so of the same rough form as human ref generally
        unit: 'HUNDREDTH_CENT',
        currency: 'USD',
        amountAccrued, 
        priorSettledBalance
    }
};

const generateEntityResponse = (entityId, entityType) => ({
    entityType,
    entityId,
    unit: 'HUNDREDTH_CENT',
    currency: 'USD',
    amountAccrued: Math.floor(Math.random() * 1e7)
});

const divideDistribution = (accrualMap, distributionPaid, bonusPoolId) => {
    const totalAccrued = Array.from(accrualMap.values()).reduce((entry, sum) => entry.amount + sum, 0);
    const remainderUnaccrued = distributionPaid - totalAccrued;
    
    const distributionMap = new Map();
    
    const accruedBn = new BigNumber(totalAccrued); // used below
    const remainderBn = new BigNumber(remainderUnaccrued);

    accrualMap.forEach((entityId, entityDetails) => {
        let amountToCredit = entityDetails.amountAccrued;
        if (remainderUnaccrued > 0) { // comes out of the bonus pool, which is the excess/overflow absorber
            const shareOfAllAccrual = new BigNumber(entityDetails.amountAccrued).dividedBy(accruedBn);
            const amountToAdd = remainderBn.times(shareOfAllAccrual);
            amountToCredit += amountToAdd.integerValue();
        } else if (remainderUnaccrued < 0 && entityDetails.entityType === 'BONUS_POOL' && entityId === bonusPoolId) {
            amountToCredit -= remainderUnaccrued;
        }
        distributionMap.set(entityId, amountToCredit);
    });

    // juuuuust in case one or two hundredths of a cent left over due to rounding
    const whollyAllocatedAmount = Array.from(distributionMap.values()).reduce((value, sum) => value + sum, 0);
    if (whollyAllocatedAmount !== distributionPaid) {
        logger(`MATH ERROR : check : after division, still mismatch, distribution paid: ${distributionPaid}, wholly allocated: ${whollyAllocatedAmount}`);
        const currentBonusAmount = distributionMap.get(bonusPoolId);
        const adjustedBonusAmount = currentBonusAmount + distributionPaid - whollyAllocatedAmount;
        distributionMap.set(bonusPoolId, adjustedBonusAmount);
    }

    return distributionMap;
};

describe('*** UNIT TEST CAPITALIZATION PREVIEW ***', () => {

    const testNumberAccounts = 1;
    const numberAccountsSampled = config.get('capitalization.preview.accountsToSample');
    
    const convertToPreview = (account, amountToCredit) => ({
        accountId: account.accountId,
        accountName: account.humanRef,
        unit: account.unit,
        currency: account.currency,
        priorBalance: account.priorSettledBalance,
        priorAccrued: account.amountAccrued,
        amountToCredit
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

        fetchLastLogStub.resolves({ clientId: testClientId, floatId: testFloatId, creationTime: testLastLogTime, logType: 'CAPITALIZATION_EVENT' });
        fetchFloatConfigVarsStub.resolves(helper.commonFloatConfig);
        fetchAccrualsStub.resolves(mockAccrualMap);

        const totalAccrued = Array.from(mockAccrualMap.values()).reduce((entry, sum) => entry.amount + sum, 0);
        const mockInterestPaid = Math.round(totalAccrued * (Math.random() * 0.2 + 1) / 100); // i.e., in the range of 20%, in cents
        const testEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            interestPaid: mockInterestPaid,
            dateTimePaid: testInterestTime.valueOf(),
            unit: 'WHOLE_CENT',
            currency: 'USD'
        };

        const resultOfPreview = await handler.preview(testEvent);
        expect(resultOfPreview).to.exist;
        
        const expectedDistributionMap = divideDistribution(mockAccrualMap, mockInterestPaid * 100, helper.commonFloatConfig.bonusPoolTracker);
        const expectedPreviewAccounts = mockAccountsFromDb.map((account) => convertToPreview(account, distributionMap.get(account.accountId)));

        expect(resultOfPreview).to.have.property('numberAccountsToBeCredited', testNumberAccounts);
        expect(resultOfPreview).to.have.property('amountToCreditClient', expectedDistributionMap.get(helper.commonFloatConfig.clientCoShareTracker));
        expect(resultOfPreview).to.have.property('amountToCreditBonusPool', expectedDistributionMap.get(helper.commonFloatConfig.bonusPoolTracker));
        expect(resultOfPreview).to.have.property('excessOverPastAccrual', mockInterestPaid - totalAccrued);
        expect(resultOfPreview).to.have.property('unit', 'HUNDREDTH_CENT');
        expect(resultOfPreview).to.have.property('currency', 'USD');

        expect(resultOfPreview).to.have.property('sampleOfTransactions');
        const returnedSample = resultOfPreview.sampleOfTransactions;
        expect(returnedSample).to.be.an('array').of.length(numberAccountsSampled);
        returnedSample.forEach((sample) => {
            expect(expectedPreviewAccounts).to.deep.include(sample); // may be possible via a single contains call?
        });

        expect(fetchLastLogStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, logType: 'CAPITALIZATION_EVENT', endTime: testInterestTime });
        expect(fetchFloatConfigVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        expect(fetchAccrualsStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, startTime: testLastLogTime, endTime: testInterestTime });

    });

    // it('Handles case where no prior capitalization', async () => {
    //     const expectedFetchParams = { clientId: testClientId, floatId: testFloatId };

    //     fetchLastLogStub.resolves(null);
    //     fetchFloatConfigVarsStub.resolves(helper.commonFloatConfig);
    //     fetchAccrualsStub.resolves([]);

    //     expect(fetchLastLogStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, logType: 'CAPITALIZATION_EVENT', endTime: testInterestTime });
    //     expect(fetchFloatConfigVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
    //     expect(fetchAccrualsStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, startTime: testLastLogTime, endTime: testInterestTime });
    // });

    // it('Validations throw required errors', async () => {

    // });

});

// note : will also need to expire the prior ones
describe('*** UNIT TEST CAPITALIZATION CONDUCT ***', () => {

    const testNumberAccounts = 1;

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

        const totalAccrued = Array.from(mockAccrualMap.values()).reduce((entry, sum) => entry.amount + sum, 0);
        const mockInterestPaid = Math.round(totalAccrued * (Math.random() * 0.2 + 1) / 100); // i.e., in the range of 20%, in cents

        const expectedDistributionMap = divideDistribution(mockAccrualMap, mockInterestPaid * 100, helper.commonFloatConfig.bonusPoolTracker);

        fetchLastLogStub.resolves({ clientId: testClientId, floatId: testFloatId, creationTime: testLastLogTime, logType: 'CAPITALIZATION_EVENT' });
        fetchFloatConfigVarsStub.resolves(helper.commonFloatConfig);
        fetchAccrualsStub.resolves(mockAccrualMap);
        
        addOrSubtractStub.resolves({ currentBalance: 1e15 + mockInterestPaid });
        allocateNonUserStub.resolves({ 'BONUS': uuid(), 'CLIENT': uuid() });
        allocateToUsersStub.resolves([]); // needs float TX ID, account TX ID (will have to insert those), amounts
        supercedeAccrualsStub.resolves();

        const testEvent = {
            clientId: testClientId,
            floatId: testFloatId,
            interestPaid: mockInterestPaid,
            dateTimePaid: testInterestTime.valueOf(),
            unit: 'WHOLE_CENT',
            currency: 'USD'
        };

        const resultOfCapitalization = await handler.confirm(testEvent);
        expect(resultOfCapitalization).to.exist;
        
        expect(resultOfCapitalization).to.have.property('numberAccountsToBeCredited', testNumberAccounts);
        expect(resultOfCapitalization).to.have.property('amountToCreditClient', expectedDistributionMap.get(helper.commonFloatConfig.clientCoShareTracker));
        expect(resultOfCapitalization).to.have.property('amountToCreditBonusPool', expectedDistributionMap.get(helper.commonFloatConfig.bonusPoolTracker));
        expect(resultOfCapitalization).to.have.property('excessOverPastAccrual', mockInterestPaid - totalAccrued);
        expect(resultOfCapitalization).to.have.property('unit', 'HUNDREDTH_CENT');
        expect(resultOfCapitalization).to.have.property('currency', 'USD');

        expect(fetchLastLogStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, logType: 'CAPITALIZATION_EVENT', endTime: testInterestTime });
        expect(fetchFloatConfigVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        expect(fetchAccrualsStub).to.have.been.calledOnceWithExactly({ ...expectedFetchParams, startTime: testLastLogTime, endTime: testInterestTime });

        expect(addOrSubtractStub).to.have.been.calledOnceWithExactly();
        expect(allocateNonUserStub).to.have.been.calledOnceWithExactly();
        expect(allocateToUsersStub).to.have.been.calledOnceWithExactly();
        expect(supercedeAccruals).to.have.been.calledOnceWithExactly('date', 'date', testClientId, testFloatId);
    });

    // it('Handles case where no prior capitalization', async () => {

    // });

    // it('Handles case where interest is less than prior accruals', async () => {

    // });

});
