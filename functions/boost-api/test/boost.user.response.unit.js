'use strict';

const uuid = require('uuid/v4');
const moment = require('moment');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const fetchBoostStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const updateBoostRedeemedStub = sinon.stub();
const getAccountIdForUserStub = sinon.stub();

const redemptionHandlerStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-process-handler', {
    './persistence/rds.boost': {
        'fetchBoost': fetchBoostStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'updateBoostAmountRedeemed': updateBoostRedeemedStub,
        'getAccountIdForUser': getAccountIdForUserStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub
    },
    '@noCallThru': true
});

describe('*** UNIT TEST USER BOOST RESPONSE ***', async () => {
    
    const testBoostId = uuid();
    const testUserId = uuid();
    const testAccountId = uuid();

    beforeEach(() => testHelper.resetStubs(fetchBoostStub, updateBoostAccountStub, updateBoostRedeemedStub, getAccountIdForUserStub, redemptionHandlerStub));

    it('Redeems when game is won', async () => {
        const testEvent = {
            eventType: 'USER_GAME_COMPLETION',
            boostId: testBoostId,
            numberTaps: 20,
            timeTakenMillis: 9000
        };
    
        const boostAsRelevant = {
            boostId: testBoostId,
            boostType: 'GAME',
            boostCategory: 'TAP_SCREEN',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000,
            fromFloatId: 'test-float',
            fromBonusPoolId: 'test-bonus-pool',
            statusConditions: {
                OFFERED: ['message_instruction_created'],
                UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
                REDEEMED: ['number_taps_greater_than #{10::10000}']
            }
        };

        fetchBoostStub.resolves(boostAsRelevant);
        getAccountIdForUserStub.resolves([testAccountId]);
        redemptionHandlerStub.resolves({ [testBoostId]: { result: 'SUCCESS' }});
        
        const mockUpdateProcessedTime = moment();
        updateBoostAccountStub.resolves([{ boostId: testBoostId, updatedTime: mockUpdateProcessedTime }]);

        const expectedResult = { 
            result: 'TRIGGERED', 
            statusMet: ['REDEEMED'], 
            amountAllocated: { amount: 50000, unit: 'HUNDREDTH_CENT', currency: 'USD' }
        };

        const result = await handler.processUserBoostResponse(testHelper.wrapEvent(testEvent, testUserId, 'ORDINARY_USER'));
        // logger('Result of user boost response processing:', result);
        expect(result).to.exist;
        expect(result.statusCode).to.deep.equal(200);
        expect(result.body).to.deep.equal(JSON.stringify(expectedResult));

        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);
        
        const expectedLogContext = { submittedParams: testEvent, processType: 'USER', newStatus: 'REDEEMED', boostAmount: 50000 };
        const expectedUpdateInstruction = {
            boostId: testBoostId,
            accountIds: [testAccountId],
            newStatus: 'REDEEMED',
            stillActive: true,
            logType: 'STATUS_CHANGE',
            logContext: expectedLogContext
        };

        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedUpdateInstruction]);
        expect(updateBoostRedeemedStub).to.have.been.calledOnceWithExactly([testBoostId]);
    });

    it('Fails when not enough taps', async () => {
        const testEvent = {
            boostId: testBoostId,
            numberTaps: 8,
            timeTakenMillis: 9000
        };
    
        const boostAsRelevant = {
            boostId: testBoostId,
            statusConditions: {
                REDEEMED: ['number_taps_greater_than #{10::10000}']
            }
        };

        fetchBoostStub.resolves(boostAsRelevant);
        
        const result = await handler.processUserBoostResponse(testHelper.wrapEvent(testEvent, testUserId, 'ORDINARY_USER'));
        // logger('Result of user boost response processing:', result);
        expect(result.statusCode).to.deep.equal(200);
        expect(result.body).to.deep.equal(JSON.stringify({ result: 'NO_CHANGE' }));

    });

    it('Handles test run', async () => {
        const result = await handler.processUserBoostResponse();
        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 400 });
    });

    it('Fails on missing authorization', async () => {
        const testEvent = { testParam: 'TEST_VAL' };
        const result = await handler.processUserBoostResponse(testEvent);
        expect(result).to.exist;
        expect(result).to.deep.equal({ statusCode: 403 });
    });

    it('Catches thrown errors', async () => {
        const testEvent = {
            body: ['BAD_BODY'],
            requestContext: {
                authorizer: {
                    systemWideUserId: testUserId,
                    userRole: 'ORDINARY_USER'
                }
            }
        };
        
        const result = await handler.processUserBoostResponse(testEvent);
        // logger('Result of user boost response processing:', result);

        expect(result).to.exist;
        expect(result.statusCode).to.equal(500);
    });
});
