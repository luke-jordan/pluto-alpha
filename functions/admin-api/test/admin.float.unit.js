'use strict';

const logger = require('debug')('jupiter:admin:float-test');
// const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');
const status = require('statuses');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const NEG_FLOW_FLAG = -1;
const POS_FLOW_FLAG = 1;

const getFloatBalanceStub = sinon.stub();
const getFloatBonusBalanceStub = sinon.stub();
const getFloatAlertsStub = sinon.stub();
const insertFloatLogStub = sinon.stub();
const updateFloatLogStub = sinon.stub();

const listCountriesClientsStub = sinon.stub();
const listClientFloatsStub = sinon.stub();
const fetchClientFloatVarsStub = sinon.stub();
const updateClientFloatVarsStub = sinon.stub();
const listRefCodesStub = sinon.stub();

const momentStub = sinon.stub();
const lambdaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const handler = proxyquire('../admin-float-handler', {
    './persistence/rds.float': {
        'getFloatBalanceAndFlows': getFloatBalanceStub,
        'getFloatBonusBalanceAndFlows': getFloatBonusBalanceStub,
        'getFloatAlerts': getFloatAlertsStub,
        'insertFloatLog': insertFloatLogStub,
        'updateFloatLog': updateFloatLogStub,
        '@noCallThru': true
    },
    './persistence/dynamo.float': {
        'listCountriesClients': listCountriesClientsStub,
        'listClientFloats': listClientFloatsStub,
        'fetchClientFloatVars': fetchClientFloatVarsStub,
        'updateClientFloatVars': updateClientFloatVarsStub,
        'listReferralCodes': listRefCodesStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient
    }
});

describe('*** UNIT TEST ADMIN FLOAT HANDLER ***', () => {
    const testUserId = uuid();
    const testClientId = uuid();
    const testFloatId = uuid();
    const testLogId = uuid();

    const testTime = moment();
    const testTimeZone = 'America/New_York';
    const testCurrency = 'USD';
    const testClientName = '';
    const testFloatName = '';

    beforeEach(() => {
        helper.resetStubs(
            getFloatBalanceStub, getFloatBonusBalanceStub, getFloatAlertsStub, insertFloatLogStub,
            updateFloatLogStub, listCountriesClientsStub, listClientFloatsStub, fetchClientFloatVarsStub, updateClientFloatVarsStub,
            momentStub, lambdaInvokeStub
        );
    });

    it('Lists clients and floats', async () => {
        const testClientIds = [{
            clientId: testClientId,
            timezone: testTimeZone,
            countryCode: 'USA',
            clientName: testClientName
        }];

        const testFloatIds = [{
            clientId: testClientId,
            floatId: testFloatId,
            defaultTimezone: testTimeZone,
            currency: testCurrency,
            floatName: testFloatName
        }];

        const testBonusPoolId = 'some_bonus_pool';

        const expectedResult = {
            [testClientId]: {
                timeZone: testTimeZone,
                countryCode: 'USA',
                clientName: testClientName,
                floats: [{
                    floatId: testFloatId,
                    floatName: testFloatName,
                    floatTimeZone: testTimeZone,
                    floatComparisons: {},
                    floatBalance: { amount: 100, currency: testCurrency, unit: 'HUNDREDTH_CENT' },
                    floatMonthGrowth: { amount: 200, currency: testCurrency, unit: 'HUNDREDTH_CENT' },
                    bonusPoolBalance: { amount: 500, currency: testCurrency, unit: 'HUNDREDTH_CENT' },
                    bonusOutflow: { amount: 510, currency: testCurrency, unit: 'HUNDREDTH_CENT' },
                    bonusInflowSum: { amount: 462, currency: testCurrency, unit: 'HUNDREDTH_CENT' },
                    bonusPoolIds: [testBonusPoolId]
                }]
            }
        };

        momentStub.returns({
            startOf: () => testTime
        });

        listCountriesClientsStub.resolves(testClientIds);
        listClientFloatsStub.resolves(testFloatIds);
        getFloatBalanceStub.withArgs([testFloatId]).resolves(new Map([[testFloatId, { [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }}]]));
        getFloatBalanceStub.withArgs([testFloatId], sinon.match.any).resolves(new Map([[testFloatId, { 'USD': { amount: 200, unit: 'HUNDREDTH_CENT' }}]]));
        getFloatBonusBalanceStub.withArgs([testFloatId]).resolves(new Map([[testFloatId, { [testBonusPoolId]: { [testCurrency]: { amount: 500, unit: 'HUNDREDTH_CENT' }}}]]));
        getFloatBonusBalanceStub.withArgs([testFloatId], sinon.match.any, sinon.match.any, NEG_FLOW_FLAG).resolves(new Map([[testFloatId, { [testBonusPoolId]: { [testCurrency]: { amount: 510, unit: 'HUNDREDTH_CENT' }}}]]));
        getFloatBonusBalanceStub.withArgs([testFloatId], sinon.match.any, sinon.match.any, POS_FLOW_FLAG).resolves(new Map([[testFloatId, { [testBonusPoolId]: { [testCurrency]: { amount: 462, unit: 'HUNDREDTH_CENT' }}}]]));        

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            }
        };

        const resultOfListing = await handler.listClientsAndFloats(testEvent);
        logger('Result of listing', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 200);
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(listCountriesClientsStub).to.have.been.calledOnceWithExactly();
        expect(listClientFloatsStub).to.have.been.calledOnceWithExactly();
        expect(getFloatBalanceStub).to.have.been.calledWith([testFloatId]);
        expect(getFloatBalanceStub).to.have.been.calledWith([testFloatId], sinon.match.any);
        expect(getFloatBonusBalanceStub).to.have.been.calledWith([testFloatId]);
        expect(getFloatBonusBalanceStub).to.have.been.calledWith([testFloatId], sinon.match.any, sinon.match.any, NEG_FLOW_FLAG);
        expect(getFloatBonusBalanceStub).to.have.been.calledWith([testFloatId], sinon.match.any, sinon.match.any, POS_FLOW_FLAG);
    });

    it('Client-Float listing fails on unauthorized access', async () => {
        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'ORDINARY_USER',
                    systemWideUserId: testUserId
                }
            }
        };

        const resultOfListing = await handler.listClientsAndFloats(testEvent);
        logger('Result of unauthorized listing', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', status('Forbidden'));
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(listCountriesClientsStub).to.have.not.been.called;
        expect(listClientFloatsStub).to.have.not.been.called;
        expect(getFloatBalanceStub).to.have.not.been.called;
        expect(getFloatBonusBalanceStub).to.have.not.been.called;
    });

    it('Fetches client float details', async () => {
        const testUpdateTime = moment().format();
        const testBonusId = 'some_bonus_pool';
        const testBonusPool = { [testCurrency]: { amount: 500, unit: 'HUNDREDTH_CENT' }};

        fetchClientFloatVarsStub.resolves({ currency: testCurrency });
        getFloatBalanceStub.withArgs([testFloatId]).resolves(new Map([[testFloatId, { [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }}]]));
        getFloatAlertsStub.resolves([{ logType: 'BALANCE_UNOBTAINABLE', logId: testLogId, logContext: { resolved: true }, updatedTime: testUpdateTime }]);
        getFloatBonusBalanceStub.withArgs([testFloatId]).resolves(new Map([[testFloatId, { [testBonusId]: testBonusPool }]]));
        listRefCodesStub.resolves([]);


        const testRequestBody = { clientId: testClientId, floatId: testFloatId };
        const testEvent = helper.wrapQueryParamEvent(testRequestBody, testUserId, 'SYSTEM_ADMIN', 'GET');

        const expectedResult = {
            currency: testCurrency,
            floatBalance: { amount: 100, currency: testCurrency, unit: 'HUNDREDTH_CENT' },
            floatAlerts: [{
                logId: testLogId,
                logType: 'BALANCE_UNOBTAINABLE',
                updatedTimeMillis: moment(testUpdateTime).valueOf(),
                logDescription: 'System error: something is wrong, the current balance cannot be retrieved',
                logContext: { resolved: true },
                isResolved: true,
                isRedFlag: false
            }],
            referralCodes: [],
            floatBonusPools: {
                [testBonusId]: testBonusPool
            }
        };

        const result = await handler.fetchClientFloatDetails(testEvent);
        logger('Result client float details extraction:', result);

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', 200);
        expect(result.headers).to.deep.equal(helper.expectedHeaders);
        expect(result.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(fetchClientFloatVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        expect(getFloatBalanceStub).to.have.been.calledOnceWithExactly([testFloatId]);
        expect(getFloatAlertsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
    });

    it('Client float details extraction fails on unauthorized access', async () => {
        const testRequestBody = { floatId: testFloatId };
        const testEvent = helper.wrapQueryParamEvent(testRequestBody, testUserId, 'ORDINARY_USER', 'GET');

        const result = await handler.fetchClientFloatDetails(testEvent);
        logger('Result client float details extraction:', result);

        expect(result).to.exist;
        expect(result).to.have.property('statusCode', status('Forbidden'));
        expect(result.headers).to.deep.equal(helper.expectedHeaders);
        expect(fetchClientFloatVarsStub).to.have.not.been.called;
        expect(getFloatBalanceStub).to.have.not.been.called;
        expect(getFloatAlertsStub).to.have.not.been.called;
    });

    const testResolutionNote = 'Just because.';

    it('Resolves client float alert', async () => {

        const testLogContext = {
            resolved: true,
            resolvedByUserId: testUserId,
            resolutionNote: testResolutionNote
        };

        updateFloatLogStub.withArgs({ logId: testLogId, contextToUpdate: testLogContext}).resolves({ command: 'UPDATE', rows: [{ 'updated_time': new Date() }]});

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({
                operation: 'RESOLVE_ALERT',
                clientId: testClientId,
                floatId: testFloatId,
                logId: testLogId,
                reasonToLog: testResolutionNote,
                amountToProcess: {
                    currency: testCurrency,
                    amount: 100,
                    unit: 'HUNDREDTH_CENT'
                }
            })
        };

        const resultOfAdjustment = await handler.adjustClientFloat(testEvent);
        logger('Update result', resultOfAdjustment);

        expect(resultOfAdjustment).to.exist;
        expect(resultOfAdjustment).to.have.property('statusCode', 200);
        expect(resultOfAdjustment.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfAdjustment.body).to.deep.equal(JSON.stringify({ result: 'SUCCESS' }));
        expect(updateFloatLogStub).to.have.been.calledOnceWithExactly({ logId: testLogId, contextToUpdate: testLogContext});
    });

    it('Reopens client float alert', async () => {

        const testLogContext = {
            resolved: false,
            reasonReopened: 'Just because.',
            reopenedBy: testUserId
        };

        updateFloatLogStub.withArgs({ logId: testLogId, contextToUpdate: testLogContext}).resolves({ command: 'UPDATE', rows: [{ 'updated_time': new Date() }]});

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({
                operation: 'REOPEN_ALERT',
                clientId: testClientId,
                floatId: testFloatId,
                logId: testLogId,
                reasonToLog: testResolutionNote,
                amountToProcess: {
                    currency: testCurrency,
                    amount: 100,
                    unit: 'HUNDREDTH_CENT'
                }
            })
        };

        const resultOfAdjustment = await handler.adjustClientFloat(testEvent);
        logger('Update result', resultOfAdjustment);

        expect(resultOfAdjustment).to.exist;
        expect(resultOfAdjustment).to.have.property('statusCode', 200);
        expect(resultOfAdjustment.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfAdjustment.body).to.deep.equal(JSON.stringify({ result: 'SUCCESS' }));
        expect(updateFloatLogStub).to.have.been.calledOnceWithExactly({ logId: testLogId, contextToUpdate: testLogContext});
    });

    it('Adjusts accrual vars', async () => {

        const existingFloatVars = {
            currency: testCurrency,
            accrualRateAnnualBps: '',
            bonusPoolShareOfAccrual: '',
            clientShareOfAccrual: '',
            prudentialFactor: ''
        };

        const updateFloatVarsArgs = {
            clientId: testClientId,
            floatId: testFloatId,
            newPrincipalVars: {
                accrualRateAnnualBps: '',
                bonusPoolShareOfAccrual: '',
                clientShareOfAccrual: '',
                prudentialFactor: ''
            }
        };

        const floatLogInsertArgs = {
            clientId: testClientId,
            floatId: testFloatId,
            logType: 'PARAMETERS_UPDATED',
            logContext: {
                logReason: testResolutionNote,
                priorState: {
                    accrualRateAnnualBps: existingFloatVars.accrualRateAnnualBps,
                    bonusPoolShareOfAccrual: existingFloatVars.bonusPoolShareOfAccrual,
                    clientShareOfAccrual: existingFloatVars.clientShareOfAccrual,
                    prudentialFactor: existingFloatVars.prudentialFactor
                },
                newState: updateFloatVarsArgs.newPrincipalVars
            }
        };

        fetchClientFloatVarsStub.withArgs(testClientId, testFloatId).resolves(existingFloatVars);
        updateClientFloatVarsStub.withArgs(updateFloatVarsArgs).resolves({ result: 'SUCCESS' });
        insertFloatLogStub.withArgs(floatLogInsertArgs).resolves(testLogId);

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({
                operation: 'ADJUST_ACCRUAL_VARS',
                clientId: testClientId,
                floatId: testFloatId,
                logId: testLogId,
                reasonToLog: testResolutionNote,
                amountToProcess: { currency: testCurrency, amount: 100, unit: 'HUNDREDTH_CENT' },
                newAccrualVars: {
                    accrualRateAnnualBps: '',
                    bonusPoolShareOfAccrual: '',
                    clientShareOfAccrual: '',
                    prudentialFactor: ''
                }
            })
        };

        const resultOfAdjustment = await handler.adjustClientFloat(testEvent);
        logger('Update result', resultOfAdjustment);

        expect(resultOfAdjustment).to.exist;
        expect(resultOfAdjustment).to.have.property('statusCode', 200);
        expect(resultOfAdjustment.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfAdjustment.body).to.deep.equal(JSON.stringify({ result: 'SUCCESS' }));
        expect(fetchClientFloatVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        expect(updateClientFloatVarsStub).to.have.been.calledOnceWithExactly(updateFloatVarsArgs);
        expect(insertFloatLogStub).to.have.been.calledOnceWithExactly(floatLogInsertArgs);
    });

    it('Allocates funds', async () => {

        const floatLogInsertArgs = {
            clientId: testClientId,
            floatId: testFloatId,
            logType: 'ADMIN_ALLOCATE_FUNDS',
            logContext: {
                adminUserId: testUserId,
                amountAllocated: { currency: testCurrency, amount: 100, unit: 'HUNDREDTH_CENT' },
                logReason: testResolutionNote
            }
        };

        const lambdaPayload = {
            instructions: [{
                floatId: testFloatId,
                clientId: testClientId,
                currency: testCurrency,
                unit: 'HUNDREDTH_CENT',
                amount: 100,
                identifier: testLogId,
                transactionType: 'ADMIN_BALANCE_RECON',
                relatedEntityType: 'ADMIN_INSTRUCTION',
                recipients: [{ recipientId: 'float-bonus-pool', amount: 100, recipientType: 'BONUS_POOL' }]
            }]
        };

        insertFloatLogStub.withArgs(floatLogInsertArgs).resolves(testLogId);        
        fetchClientFloatVarsStub.withArgs(testClientId, testFloatId).resolves({ bonusPoolSystemWideId: 'float-bonus-pool' });
        lambdaInvokeStub.returns({
            promise: () => helper.mockLambdaResponse({ [testLogId]: { floatTxIds: [uuid()]}})
        });

        const testEvent = {
            requestContext: { authorizer: { role: 'SYSTEM_ADMIN', systemWideUserId: testUserId }},
            body: JSON.stringify({
                operation: 'ALLOCATE_FUNDS',
                allocateTo: 'BONUS_POOL',
                clientId: testClientId,
                floatId: testFloatId,
                logId: testLogId,
                reasonToLog: testResolutionNote,
                amountToProcess: { currency: testCurrency, amount: 100, unit: 'HUNDREDTH_CENT' }
            })
        };

        const resultOfAllocation = await handler.adjustClientFloat(testEvent);
        logger('Update result', resultOfAllocation);

        expect(resultOfAllocation).to.exist;
        expect(resultOfAllocation).to.have.property('statusCode', 200);
        expect(resultOfAllocation.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfAllocation.body).to.deep.equal(JSON.stringify({ result: 'SUCCESS' }));
        expect(insertFloatLogStub).to.have.been.calledOnceWithExactly(floatLogInsertArgs);
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(helper.wrapLambdaInvoc('float_transfer', false, lambdaPayload));
    });

    it('Adds or subtract funds', async () => {

        const floatLogInsertArgs = {
            clientId: testClientId,
            floatId: testFloatId,
            logType: 'BALANCE_UPDATED_MANUALLY',
            logContext: {
                adminUserId: testUserId,
                amountAdjusted: { currency: testCurrency, amount: 100, unit: 'HUNDREDTH_CENT' },
                logReason: testResolutionNote
            }
        };

        const lambdaPayload = {
            instructions: [{
                identifier: testLogId,
                floatId: testFloatId,
                clientId: testClientId,
                currency: testCurrency,
                unit: 'HUNDREDTH_CENT',
                amount: 100,
                transactionType: 'ADMIN_BALANCE_RECON',
                logType: 'ADMIN_BALANCE_RECON',
                relatedEntityType: 'ADMIN_INSTRUCTION',
                recipients: [{ recipientId: testFloatId, amount: 100, recipientType: 'FLOAT_ITSELF'}]
            }]
        };

        insertFloatLogStub.withArgs(floatLogInsertArgs).resolves(testLogId);        
        lambdaInvokeStub.withArgs(helper.wrapLambdaInvoc('float_transfer', false, lambdaPayload)).returns({
            promise: () => helper.mockLambdaResponse({ [testLogId]: { floatTxIds: [uuid()]}})
        });       

        const testEvent = {
            requestContext: {
                authorizer: { role: 'SYSTEM_ADMIN', systemWideUserId: testUserId }
            },
            body: JSON.stringify({
                operation: 'ADD_SUBTRACT_FUNDS',
                clientId: testClientId,
                floatId: testFloatId,
                logId: testLogId,
                reasonToLog: testResolutionNote,
                amountToProcess: { currency: testCurrency, amount: 100, unit: 'HUNDREDTH_CENT' }
            })
        };

        const resultOfAdjustment = await handler.adjustClientFloat(testEvent);
        logger('Update result', resultOfAdjustment);

        expect(resultOfAdjustment).to.exist;
        expect(resultOfAdjustment).to.have.property('statusCode', 200);
        expect(resultOfAdjustment.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfAdjustment.body).to.deep.equal(JSON.stringify({ result: 'SUCCESS' }));
        expect(insertFloatLogStub).to.have.been.calledOnceWithExactly(floatLogInsertArgs);
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(helper.wrapLambdaInvoc('float_transfer', false, lambdaPayload));
    });

    it('Distributes float to users', async () => {

        const floatLogInsertArgs = {
            clientId: testClientId,
            floatId: testFloatId,
            logType: 'ADMIN_DISTRIBUTE_USERS',
            logContext: {
                adminUserId: testUserId,
                amountDistributed: { currency: testCurrency, amount: 100, unit: 'HUNDREDTH_CENT' },
                logReason: testResolutionNote
            }
        };

        const lambdaPayload = {
            instructions: [{
                floatId: testFloatId,
                clientId: testClientId,
                currency: testCurrency,
                amount: 100,
                unit: 'HUNDREDTH_CENT',
                identifier: testLogId,
                transactionType: 'ADMIN_BALANCE_RECON',
                relatedEntityType: 'ADMIN_INSTRUCTION',
                recipients: [{'recipientType': 'ALL_USERS', 'amount': 100 }]
            }]
        };

        insertFloatLogStub.withArgs(floatLogInsertArgs).resolves(testLogId);        
        lambdaInvokeStub.withArgs(helper.wrapLambdaInvoc('float_transfer', false, lambdaPayload)).returns({
            promise: () => helper.mockLambdaResponse({ [testLogId]: { floatTxIds: [uuid()]}})
        });

        const testEvent = {
            requestContext: {
                authorizer: { role: 'SYSTEM_ADMIN', systemWideUserId: testUserId }
            },
            body: JSON.stringify({
                operation: 'DISTRIBUTE_TO_USERS',
                clientId: testClientId,
                floatId: testFloatId,
                logId: testLogId,
                reasonToLog: testResolutionNote,
                amountToProcess: { currency: testCurrency, amount: 100, unit: 'HUNDREDTH_CENT' }
            })
        };

        const resultOfAdjustment = await handler.adjustClientFloat(testEvent);
        logger('Update result', resultOfAdjustment);

        expect(resultOfAdjustment).to.exist;
        expect(resultOfAdjustment).to.have.property('statusCode', 200);
        expect(resultOfAdjustment.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfAdjustment.body).to.deep.equal(JSON.stringify({ result: 'SUCCESS' }));
        expect(insertFloatLogStub).to.have.been.calledOnceWithExactly(floatLogInsertArgs);
        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(helper.wrapLambdaInvoc('float_transfer', false, lambdaPayload));
    });

    it('Catches thrown errors', async () => {

        const testEvent = {
            requestContext: {
                authorizer: { role: 'SYSTEM_ADMIN', systemWideUserId: testUserId }
            },
            body: JSON.stringify({
                operation: 'DO_SOMETHING_UNKNOWN',
                clientId: testClientId,
                floatId: testFloatId,
                logId: testLogId,
                reasonToLog: testResolutionNote,
                amountToProcess: { currency: testCurrency, amount: 100, unit: 'HUNDREDTH_CENT' }
            })
        };

        const resultOfAdjustment = await handler.adjustClientFloat(testEvent);
        logger('Update result', resultOfAdjustment);

        expect(resultOfAdjustment).to.exist;
        expect(resultOfAdjustment).to.have.property('statusCode', 500);
        expect(resultOfAdjustment.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfAdjustment.body).to.deep.equal(JSON.stringify('Missing or unknown operation: '));
        expect(lambdaInvokeStub).to.have.not.been.called;
        expect(insertFloatLogStub).to.have.not.been.called;
    });
});
