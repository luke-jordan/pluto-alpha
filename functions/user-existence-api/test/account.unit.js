'use strict';

process.env.NODE_ENV = 'test';

const logger = require('debug')('jupiter:account:test');
const uuid = require('uuid/v4');
const moment = require('moment');

const chai = require('chai');
const sinon = require('sinon');
const expect = chai.expect;
chai.use(require('chai-uuid'));
// const testHelper = require('./test.helper');

const proxyquire = require('proxyquire').noCallThru();

const insertRecordStub = sinon.stub();
const getAccountIdForUserStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const accountHandler = proxyquire('../account-handler', { 
    './persistence/rds': {
        'insertAccountRecord': insertRecordStub,
        'getAccountIdForUser': getAccountIdForUserStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    }
});

const testValidApiEvent = require('./api-event-valid.json');
const testUserId = '2c957aca-47f9-4b4d-857f-a3205bfc6a78';
const testAccountId = uuid();

const testAccountOpeningRequest = {
    ownerUserId: testUserId,
    clientId: 'some_country_client',
    defaultFloatId: 'usd_primary_mmkt'
};

const wellFormedPersistenceReq = {
    accountId: sinon.match.string, 
    clientId: 'some_country_client',
    defaultFloatId: 'usd_primary_mmkt',
    ownerUserId: testUserId
};

const testPersistedTime = moment();
const expectedMillis = testPersistedTime.startOf('second').valueOf();

const testAccountOpeningResult = {
    'accountId': testAccountId,
    'persistedTime': testPersistedTime.format()
};

describe('transformEvent', () => {
    it('Event comes in from API Gateway', async () => {
        logger('Checking API gateway handled properly');

        const body = accountHandler.transformEvent(testValidApiEvent);
        const expectedBody = JSON.parse(testValidApiEvent['body']);
        
        expect(body).to.exist;
        expect(body).not.empty;
        expect(body).to.deep.equal(expectedBody);
    });

    it('Event comes in from Lambda invoke', async () => {
        logger('Checking direct invoke handled properly');

        const dict = testValidApiEvent;
        const eventBody = JSON.parse(dict['body']);

        const transformed = accountHandler.transformEvent(eventBody);
        expect(transformed).to.exist;
        expect(transformed).not.empty;
        expect(transformed).to.eql(eventBody);
    });
});

describe('validateEvent', () => {
    it('Valid event should be validated', async () => {
        const validation = accountHandler.validateRequest(testAccountOpeningRequest);
        expect(validation).to.be.true;
    });

    it('Event without client Id or float Id should not be validated', async () => {
        const validationNoClient = accountHandler.validateRequest({ 'ownerUserId': uuid()});
        expect(validationNoClient).to.be.false;
        const noFloatEvent = JSON.parse(JSON.stringify(testAccountOpeningRequest));
        Reflect.deleteProperty(noFloatEvent, 'defaultFloatId');
        const validationNoFloat = accountHandler.validateRequest(noFloatEvent);
        expect(validationNoFloat).to.be.false;
    });

    it('Event without system wide ID should not be validated', async () => {
        const validation = accountHandler.validateRequest({ 
            clientId: 'some_country_client',
            defaultFloatId: 'usd_mmkt_primary'
        });
        expect(validation).to.be.false;
    });

    it('Event with system wide ID that is not a UUID should not be validated', async () => {
        const testEvent = JSON.parse(JSON.stringify(testAccountOpeningRequest));
        testEvent.ownerUserId = 'not-a-uuid';
        const validation = accountHandler.validateRequest(testEvent);
        expect(validation).to.be.false;
    });
});

describe('createAccountMethod', () => {
    
    const testCreationRequest = {
        ownerUserId: testUserId,
        clientId: 'some_country_client',
        defaultFloatId: 'usd_primary_mmkt',
        referralCodeDetails: {
            creatingUserId: testUserId,
            codeType: 'USER',
            context: {
                boostAmountOffered: 20,
                boostSource: 'TEST_VAL'
            }
        }
    };

    const insertArgs = {
        accountId: sinon.match.string,
        clientId: 'some_country_client',
        defaultFloatId: 'usd_primary_mmkt',
        ownerUserId: testCreationRequest.ownerUserId
    };

    beforeEach(() => {
        insertRecordStub.reset();
        getAccountIdForUserStub.reset();
        lamdbaInvokeStub.reset();
    });

    it('Basic defaults work', async () => {
        getAccountIdForUserStub.withArgs(testUserId).resolves(testAccountId);
        insertRecordStub.withArgs(insertArgs).resolves(testAccountOpeningResult);
        lamdbaInvokeStub.returns({ promise: () => ({ statusCode: 200 })});
        const response = await accountHandler.createAccount(testCreationRequest);
        expect(response).to.exist;
        expect(response.accountId).to.be.a.uuid('v4');
        expect(response.persistedTimeMillis).to.equal(expectedMillis);
        expect(getAccountIdForUserStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(insertRecordStub).to.have.been.calledOnceWithExactly(insertArgs);
        expect(lamdbaInvokeStub).to.have.been.calledOnce;
    });

    it('Fails where referring user has no account id', async () => {
        getAccountIdForUserStub.withArgs(testUserId).resolves(null);
        insertRecordStub.withArgs(insertArgs).resolves(testAccountOpeningResult);
        lamdbaInvokeStub.returns({ promise: () => ({ statusCode: 200 })});
        const response = await accountHandler.createAccount(testCreationRequest);
        expect(response).to.exist;
        expect(response.accountId).to.be.a.uuid('v4');
        expect(response.persistedTimeMillis).to.equal(expectedMillis);
        expect(getAccountIdForUserStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(insertRecordStub).to.have.been.calledOnceWithExactly(insertArgs);
        expect(lamdbaInvokeStub).to.have.not.been.called;
    });

    it('Handles non-USER referral type', async () => {
        getAccountIdForUserStub.withArgs(testUserId).resolves(testAccountId);
        insertRecordStub.withArgs(insertArgs).resolves(testAccountOpeningResult);
        lamdbaInvokeStub.returns({ promise: () => ({ statusCode: 200 })});
        testCreationRequest.referralCodeDetails.codeType = 'OTHER';
        const response = await accountHandler.createAccount(testCreationRequest);
        logger('RESULT:', response);
        expect(response).to.exist;
        expect(response.accountId).to.be.a.uuid('v4');
        expect(response.persistedTimeMillis).to.equal(expectedMillis);
        expect(getAccountIdForUserStub).to.have.not.been.called;
        expect(insertRecordStub).to.have.been.calledOnceWithExactly(insertArgs);
        expect(lamdbaInvokeStub).to.have.been.calledOnce;
    });

});

describe('handlerFunctionCreateAccount', () => {
    beforeEach(() => {
        insertRecordStub.reset();
    });
    
    it('End to end, same owner and user', async () => {
        // withArgs(sinon.match(wellFormedPersistenceReq)).
        insertRecordStub.resolves(testAccountOpeningResult);
        const response = await accountHandler.create(testValidApiEvent, null);
        
        expect(response.statusCode).to.equal(200);
        expect(response.body).to.exist;
        expect(response.body).to.be.string;

        const bodyParsed = JSON.parse(response.body);

        expect(bodyParsed.accountId).to.be.a.uuid('v4');
        expect(bodyParsed.persistedTimeMillis).to.equal(expectedMillis);

        expect(insertRecordStub).to.have.been.calledWith(wellFormedPersistenceReq);
    });

    it('Handles errors in accordance with standards', async () => {
        const response = await accountHandler.create({ userFirstName: 'Luke' });
        expect(response.statusCode).to.equal(400);
        expect(response.body).to.equal(`Error! Invalid request. All valid requests require a responsible client id, float id, and the owner's user id`);
    });

    it('Handles error from DB correctly', async () => {
        const badRequest = JSON.parse(testValidApiEvent['body']);
        badRequest.ownerUserId = uuid(); // ie just so it doesn't match, could be too many or some other failure
        insertRecordStub.withArgs(sinon.match(badRequest)).rejects(new Error('Error inserting row into persistence layer, check request'));
        const response = await accountHandler.create(badRequest);
        expect(response.statusCode).to.equal(500);
        expect(response.body).to.equal(`Error inserting row into persistence layer, check request`);
    });
});

