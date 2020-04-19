'use strict';

const logger = require('debug')('jupiter:third-parties:sendgrid:test');
const config = require('config');
const uuid = require('uuid/v4');

const moment = require('moment');

// we use this for the mail transform into request options
const { classes: { Mail } } = require('@sendgrid/helpers');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const requestStub = sinon.stub();
const tinyPostStub = sinon.stub();

const sendGridStub = sinon.stub();
const getObjectStub = sinon.stub();

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub;
    }
}

const handler = proxyquire('../outbound-message-handler', {
    'request-promise': requestStub,
    'tiny-json-http': {
        'post': tinyPostStub,
        '@noCallThru': true
    },
    'aws-sdk': { 'S3': MockS3Client }
});

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

describe('*** UNIT TEST EMAIL MESSSAGE DISPATCH ***', async () => {
    const testMessageId = uuid();

    const chunkSize = config.get('sendgrid.chunkSize');
    const sendgridOkayResponse = { body: '', headers: { connection: 'close' }};
    
    // const sendgridOkayResponse = [{ toJSON: () => ({ statusCode: 200 })}];
    // const sendgridOkayChunk = (numberMsgs = chunkSize) => Array(numberMsgs).fill(sendgridOkayResponse);

    const validEmailEvent = (messageId = uuid()) => ({
        messageId,
        to: 'user@email.org',
        from: config.get('sendgrid.fromAddress'),
        subject: 'Welcome to Jupiter',
        text: 'Greetings. Welcome to jupiter',
        html: '<p>Greetings. Welcome to jupiter</p>'
    });

    const validEmailMessage = {
        'to': 'user@email.org',
        'from': config.get('sendgrid.fromAddress'),
        'subject': 'Welcome to Jupiter',
        'text': 'Greetings. Welcome to jupiter',
        'html': '<p>Greetings. Welcome to jupiter</p>',
        'mail_settings': { 'sandbox_mode': { 'enable': true }}
    };

    const wrappedPost = (body) => ({
        url: config.get('sendgrid.endpoint'),
        headers: {
            'Authorization': `Bearer ${config.get('sendgrid.apiKey')}`,
            'Content-Type': 'application/json'
        },
        data: body
    });

    beforeEach(() => {
        resetStubs(sendGridStub, requestStub, tinyPostStub);
    });

    it('Handled warm up event', async () => {
        const result = await handler.handleOutboundMessages({ });

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'Empty invocation' });

        expect(sendGridStub).to.have.not.been.called;
        expect(tinyPostStub).to.not.have.been.called;        
    });

    it('Sends out emails', async () => {
        tinyPostStub.resolves(sendgridOkayResponse);

        const expectedResult = { result: 'SUCCESS', failedMessageIds: [] };

        const testEvent = {
            emailMessages: [validEmailEvent(testMessageId), validEmailEvent(testMessageId), validEmailEvent(testMessageId)]
        };

        const result = await handler.handleOutboundMessages(testEvent);
        expect(result).to.deep.equal(expectedResult);

        expect(tinyPostStub).to.have.been.calledThrice;

        const createdMail = Mail.create(validEmailMessage);
        const mailBody = createdMail.toJSON();
        
        logger('Mail body: ', mailBody);
        expect(tinyPostStub).to.have.been.calledThrice;
        expect(tinyPostStub).to.have.been.calledWithExactly(wrappedPost(mailBody));
    });

    it('Retries when first call fails', async () => {
        tinyPostStub.onFirstCall().rejects(Error('POST failed with 401'));
        tinyPostStub.onSecondCall().rejects(Error('POST failed with 401'));
        tinyPostStub.onThirdCall().resolves(sendgridOkayResponse);

        const expectedResult = { result: 'SUCCESS', failedMessageIds: [] };

        const testEvent = {
            emailMessages: [validEmailEvent(testMessageId)]
        };

        const result = await handler.handleOutboundMessages(testEvent);
        expect(result).to.deep.equal(expectedResult);

        expect(tinyPostStub).to.have.been.calledThrice;

        const createdMail = Mail.create(validEmailMessage);
        const mailBody = createdMail.toJSON();
        
        logger('Mail body: ', mailBody);
        expect(tinyPostStub).to.have.been.calledThrice;
        expect(tinyPostStub).to.have.been.calledWith(wrappedPost(mailBody));        
    });

    it('Sends out emails with template wrapper', async () => {
        const numberMessages = 4;

        const mockWrapper = '<html><title></title><body>{htmlBody}</body></html>';

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => mockWrapper }})});
        tinyPostStub.resolves(sendgridOkayResponse);

        const testMessages = Array(numberMessages).fill(validEmailEvent(testMessageId));
        const testWrapper = { s3bucket: 'email.templates', s3key: 'wrapper.html' };

        const testEvent = {
            emailMessages: testMessages,
            emailWrapper: testWrapper
        };

        const result = await handler.handleOutboundMessages(testEvent);
        expect(result).to.deep.equal({ result: 'SUCCESS', failedMessageIds: [] });

        const expectedWrappedMessage = '<html><title></title><body><p>Greetings. Welcome to jupiter</p></body></html>';
        const expectedMessages = Array(numberMessages).fill(validEmailMessage).map((msg) => ({ ...msg, 'html': expectedWrappedMessage }));
        
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: 'email.templates', Key: 'wrapper.html' });
        expect(tinyPostStub).to.have.been.callCount(4);
        expectedMessages.forEach((msg, index) => {
            const createdMail = Mail.create(msg);
            const mailBody = createdMail.toJSON();    
            expect(tinyPostStub.getCall(index).args[0]).to.deep.equal(wrappedPost(mailBody));
        });
    });

    it('Handles payload chunking where third party rate limit is exceeded', async () => {
        const emailMessages = [];
        
        const baseChunks = 1;
        const trailingChunkSize = 652;
        const numberMessages = baseChunks * chunkSize + trailingChunkSize;

        while (emailMessages.length < numberMessages) {
            emailMessages.push(validEmailEvent(testMessageId));
        }

        tinyPostStub.resolves(sendgridOkayResponse);
        // sendGridStub.onCall(3).resolves(sendgridOkayChunk(trailingChunkSize));

        const expectedResult = { result: 'SUCCESS', failedMessageIds: [] };

        const result = await handler.handleOutboundMessages({ emailMessages });

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        // todo : when this becomes an issue, insert a backoff/delay, and test fo rit
        expect(tinyPostStub).to.have.been.callCount(numberMessages);
    });

    it('Isolated failures and returns failed message ids to caller', async () => {
        const emailMessages = [];

        const numberMessages = 3;

        while (emailMessages.length < numberMessages) {
            emailMessages.push(validEmailEvent());
        }

        const expectedRetryAttempts = 4;
        const mockFailures = expectedRetryAttempts * numberMessages - 1;
        Array(mockFailures).fill().forEach((_, i) => tinyPostStub.onCall(i).rejects('401 error'));
        tinyPostStub.resolves(sendgridOkayResponse);

        const result = await handler.handleOutboundMessages({ emailMessages });

        expect(result).to.exist;

        expect(result).to.have.property('result', 'PARTIAL');
        expect(result).to.have.property('failedMessageIds');

        expect(result.failedMessageIds.length).to.deep.equal(2);

        expect(tinyPostStub).to.have.callCount(expectedRetryAttempts * numberMessages);
    });

    it('Fails where no valid emails are found', async () => {
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const expectedResult = { result: 'ERR', message: 'No valid emails found' };

        const invalidEmailEvent = { ...validEmailEvent(testMessageId) };
        Reflect.deleteProperty(invalidEmailEvent, 'from');

        const testEvent = {
            emailMessages: [invalidEmailEvent, invalidEmailEvent, invalidEmailEvent]
        };

        const result = await handler.handleOutboundMessages(testEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(tinyPostStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        tinyPostStub.throws(new Error('Dispatch error'));

        const expectedResult = { result: 'ERR', message: 'Dispatch error' };

        const testEvent = {
            emailMessages: [validEmailEvent(testMessageId), validEmailEvent(testMessageId), validEmailEvent(testMessageId)]
        };

        const result = await handler.handleOutboundMessages(testEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        const expectedRetryAttempts = 4;
        const expectedCalls = testEvent.emailMessages.length * expectedRetryAttempts;
        expect(tinyPostStub).to.have.callCount(expectedCalls);
    });

});

describe('*** UNIT TEST SMS FUNCTION ***', async () => {
    const testPhoneNumber = '+27643534501';
    const testMessage = 'Greetings from Jupiter.';

    const testMessageId = uuid();

    const testCurrentTime = moment();
    const testUpdateTime = testCurrentTime.add(5, 'minutes');

    const mockTwilioResponse = {
        'account_sid': config.get('twilio.accountSid'),
        'api_version': '2010-04-01',
        'body': 'body',
        'date_created': testCurrentTime.format(),
        'date_sent': testCurrentTime.format(),
        'date_updated': testUpdateTime.format(),
        'direction': 'outbound-api',
        'error_code': null,
        'error_message': null,
        'from': '+15017122661',
        'messaging_service_sid': uuid(),
        'num_media': '0',
        'num_segments': '1',
        'price': null,
        'price_unit': null,
        'sid': uuid(),
        'status': 'sent',
        'subresource_uris': {
            'media': `/2010-04-01/Accounts/${config.get('twilio.accountSid')}/Messages/${testMessageId}/Media.json`
        },
        'to': '+15558675310',
        'uri': `/2010-04-01/Accounts/${config.get('twilio.accountSid')}/Messages/${testMessageId}.json`
    };

    beforeEach(() => {
        resetStubs(requestStub);
    });

    it('Sends sms messages', async () => {
        const expectedOptions = {
            method: 'POST',
            uri: `https://api.twilio.com/2010-04-01/Accounts/${config.get('twilio.accountSid')}/Messages`,
            form: {
                Body: testMessage,
                From: config.get('twilio.number'),
                To: testPhoneNumber
            },
            auth: {
                username: config.get('twilio.accountSid'),
                password: config.get('twilio.authToken')
            },
            json: true
        };

        requestStub.resolves(mockTwilioResponse);

        const testEvent = { phoneNumber: testPhoneNumber, message: testMessage };

        const resultOfDispatch = await handler.handleOutboundMessages(testEvent);

        expect(resultOfDispatch).to.exist;
        expect(resultOfDispatch).to.deep.equal({ result: 'SUCCESS' });

        if (config.has('twilio.mock') && config.get('twilio.mock') === 'OFF') {
            expect(requestStub).to.have.been.calledOnceWithExactly(expectedOptions);
        }
    });
});
