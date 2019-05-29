process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:account:test');
const uuid = require('uuid/v4');

const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-uuid'));

const proxyquire = require('proxyquire').noCallThru();

var rdsStub = { };

const accountHandler = proxyquire('../account', { './persistence/rds': rdsStub });

// Setting up the stubs
const testUserId = uuid();
const testAccountId = uuid();

const testAccountOpeningRequest = {
    ownerUserId: testUserId,
    clientId: 'pluto_savings_za',
    defaultFloatId: 'zar_cash_float',
    userFirstName: 'Luke',
    userFamilyName: 'Jordan'
}

const wellFormedPersistenceReq = {
    'accountId': testAccountId, 
    'clientId': 'pluto_savings_za',
    'defaultFloatId': 'zar_cash_float',
    'ownerUserId': testUserId, 
    'userFirstName': 'Luke',
    'userFamilyName': 'Jordan'
}

const testAccountOpeningResult = {
    account_id: testAccountId,
    tags: [],
    flags: []
}

rdsStub.insertAccountRecord = function(wellFormedPersistenceReq) { 
    return testAccountOpeningResult; 
};

describe('transformEvent', () => {
    it('Event comes in from API Gateway', async () => {
        logger('Checking API gateway handled properly');

        const event = require('./api-event-valid.json');
        const body = accountHandler.transformEvent(event);

        expect(body).to.exist;
        expect(body).not.empty;
        expect(body).to.eql(JSON.parse(event['body']));
    });

    it('Event comes in from Lambda invoke', async () => {
        logger('Checking direct invoke handled properly');

        const dict = require('./api-event-valid.json');
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

    it('Event without system wide ID should not be validated', async () => {
        const validation = accountHandler.validateRequest({ 'userFirstName': 'Luke', 'userFamilyName': 'Jordan'});
        expect(validation).to.be.false;
    });

    it('Event without name should not be validated', async () => {
        const validation = accountHandler.validateRequest({ 'ownerUserId': uuid() });
        expect(validation).to.be.false;
    })

    it('Event with system wide ID that is not a UUID should not be validated', async () => {
        const validation = accountHandler.validateRequest({ 'ownerUserId': 'hello-something', 'userFirstName': 'Luke', 'userFamilyName': 'Jordan' });
        expect(validation).to.be.false;
    })
})

describe('createAccountMethod', () => {
    it('Basic defaults work', async () => {
        const response = await accountHandler.createAccount(testAccountOpeningRequest);
        expect(response).to.exist;
        expect(response.accountId).to.be.a.uuid('v4');
        expect(response.tags).to.be.empty;
        expect(response.flags).to.be.empty;
    });
});

describe('handlerFunctionCreateAccount', () => {
    it('End to end, same owner and user', async () => {
        const event = require('./api-event-valid.json');

        const response = await accountHandler.create(event, null);
        logger('Response from handler create: ', response);

        expect(response.statusCode).to.equal(200);
        expect(response.body).to.exist;
        expect(response.body).to.be.string;

        const bodyParsed = JSON.parse(response.body);

        expect(bodyParsed.accountId).to.be.a.uuid('v4');
        expect(bodyParsed.tags).to.be.empty;
        expect(bodyParsed.flags).to.be.empty;
    })
})