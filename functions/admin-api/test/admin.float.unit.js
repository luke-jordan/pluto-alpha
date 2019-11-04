'use strict';

const logger = require('debug')('jupiter:admin:float-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const getFloatBalanceStub = sinon.stub();
const getFloatBonusBalanceStub = sinon.stub();
const getFloatAlertsStub = sinon.stub();
const insertFloatLogStub = sinon.stub();
const updateFloatLogStub = sinon.stub();
const listCountriesClientsStub = sinon.stub();
const listClientFloatsStub = sinon.stub();
const fetchClientFloatVarsStub = sinon.stub();
const updateClientFloatVarsStub = sinon.stub();
const momentStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../admin-float-handler', {
    './persistence/rds.float': {
        'getFloatBalanceAndFlows': getFloatBalanceStub,
        'getFloatBonusBalanceAndFlows': getFloatBonusBalanceStub,
        'getFloatAlerts': getFloatAlertsStub,
        'insertFloatLog': insertFloatLogStub,
        'updateFloatLog': updateFloatLogStub
    },
    './persistence/dynamo.float': {
        'listCountriesClients': listCountriesClientsStub,
        'listClientFloats': listClientFloatsStub,
        'fetchClientFloatVars': fetchClientFloatVarsStub,
        'updateClientFloatVars': updateClientFloatVarsStub
    },
    // 'moment': momentStub,
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

describe('*** UNIT TEST DYNAMO FLOAT ***', () => {
    const testUserId = uuid();
    const testClientId = uuid();
    const testFloatId = uuid();

    const testTime = moment();
    const testTimeZone = '';
    const testCurrency = 'USD';

    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({
            statusCode,
            body: JSON.stringify(body)
        })
    });

    beforeEach(() => {
        helper.resetStubs(getFloatBalanceStub, getFloatBonusBalanceStub, getFloatAlertsStub, insertFloatLogStub,
            updateFloatLogStub, listCountriesClientsStub, listClientFloatsStub, fetchClientFloatVarsStub, updateClientFloatVarsStub,
            momentStub, lamdbaInvokeStub
        );
    });

    it('Lists clients and floats', async () => {
        const testClientIds = [{
            clientId: testClientId,
            timezone: testTimeZone,
            countryCode: 'USA',
            clientName: ''
        }];

        const testFloatIds = [{
            clientId: testClientId,
            floatId: testFloatId,
            defaultTimezone: testTimeZone,
            currency: testCurrency,
            floatName: ''
        }];

        momentStub.returns({
            startOf: () => testTime
        });

        listCountriesClientsStub.resolves(testClientIds);
        listClientFloatsStub.resolves(testFloatIds);
        getFloatBalanceStub.withArgs([testFloatId]).resolves(new Map([[testFloatId, { [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }}]]));
        getFloatBalanceStub.withArgs([testFloatId], sinon.match.any).resolves(new Map([[testFloatId, { 'USD': { amount: 200, unit: 'HUNDREDTH_CENT' }}]]));
        getFloatBonusBalanceStub.withArgs([testFloatId]).resolves(new Map([[testFloatId, { [testFloatId]: { [testCurrency]: { amount: 500, unit: 'HUNDREDTH_CENT' }}}]]));
        getFloatBonusBalanceStub.withArgs([testFloatId], sinon.match.any, sinon.match.any, -1).resolves(new Map([[testFloatId, { [testFloatId]: { [testCurrency]: { amount: 510, unit: 'HUNDREDTH_CENT' }}}]]));
        getFloatBonusBalanceStub.withArgs([testFloatId], sinon.match.any, sinon.match.any, 1).resolves(new Map([[testFloatId, { [testFloatId]: { [testCurrency]: { amount: 462, unit: 'HUNDREDTH_CENT' }}}]]));        

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
        logger('Result of listing', resultOfListing);
    });

    it('Fetches client float details', async () => {
        fetchClientFloatVarsStub.resolves({ currency: testCurrency });
        getFloatBalanceStub.withArgs([testFloatId]).resolves(new Map([[testFloatId, { [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }}]]));
        getFloatAlertsStub.resolves([{ logType: 'BALANCE_UNOBTAINABLE', logId: uuid(), logContext: { resolved: true }}])

        const testRequestBody = { floatId: testFloatId };
        const testEvent = helper.wrapQueryParamEvent(testRequestBody, testUserId, 'SYSTEM_ADMIN', 'GET');

        const result = await handler.fetchClientFloatDetails(testEvent);
        logger('Result client float details extraction:', result);
    });

    it('Client float details extraction fails on unauthorized access', async () => {
        const testRequestBody = { floatId: testFloatId };
        const testEvent = helper.wrapQueryParamEvent(testRequestBody, testUserId, 'ORDINARY_USER', 'GET');

        const result = await handler.fetchClientFloatDetails(testEvent);
        logger('Result client float details extraction:', result);;
    });

    ///////////////////////////////////////////////////////////
    ////////////////// adjustClientFloat() ////////////////////
    ///////////////////////////////////////////////////////////

    it('Resolves client float alert', async () => {
        const testLogId = uuid();
        const testResolutionNote = 'Just because.';

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
    });

    it('Reopens client float alert', async () => {
        const testLogId = uuid();
        const testResolutionNote = 'Just because.';

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
    });

    it('Adjusts accrual vars', async () => {
        const testLogId = uuid();
        const testResolutionNote = 'Just because.';

        const expectedFloatVars = {
            currency: testCurrency,
            accrualRateAnnualBps: '',
            bonusPoolShareOfAccrual: '',
            clientShareOfAccrual: '',
            prudentialFactor: ''
        };

        fetchClientFloatVarsStub.resolves(expectedFloatVars);
        updateClientFloatVarsStub.resolves({ result: 'SUCCESS' });
        insertFloatLogStub.resolves(testLogId);

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
                amountToProcess: {
                    currency: testCurrency,
                    amount: 100,
                    unit: 'HUNDREDTH_CENT'
                },
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
    });

    it('Allocates funds', async () => {
        const testLogId = uuid();
        const testResolutionNote = 'Just because.';

        insertFloatLogStub.resolves(testLogId);        
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse({ [testLogId]: { floatTxIds: [ uuid() ]}})});

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({
                operation: 'ALLOCATE_FUNDS',
                allocateTo: {
                    id: testUserId,
                    type: ''
                },
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
    });

    it('Adds or subtract funds', async () => {
        const testLogId = uuid();
        const testResolutionNote = 'Just because.';

        insertFloatLogStub.resolves(testLogId);        
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse({ [testLogId]: { floatTxIds: [ uuid() ]}})});

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({
                operation: 'ADD_SUBTRACT_FUNDS',
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
    });

    it('Distributes float to users', async () => {
        const testLogId = uuid();
        const testResolutionNote = 'Just because.';

        insertFloatLogStub.resolves(testLogId);        
        lamdbaInvokeStub.returns({ promise: () => mockLambdaResponse({ [testLogId]: { floatTxIds: [ uuid() ]}})});

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({
                operation: 'DISTRIBUTE_TO_USERS',
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
    });

    it('Cathces thrown errors', async () => {
        const testLogId = uuid();
        const testResolutionNote = 'Just because.';

        const testEvent = {
            requestContext: {
                authorizer: {
                    role: 'SYSTEM_ADMIN',
                    systemWideUserId: testUserId
                }
            },
            body: JSON.stringify({
                operation: 'DO_SOMETHING_UNKNOWN',
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
    });
});