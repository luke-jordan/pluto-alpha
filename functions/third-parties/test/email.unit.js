'use strict';

// const logger = require('debug')('jupiter:third-parties:sendgrid-unit-test');
const config = require('config');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const sendGridStub = sinon.stub();
const setApiKeyStub = sinon.stub();
const setSubstitutionsStub = sinon.stub();
const getObjectStub = sinon.stub();

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub;
    }
}

const handler = proxyquire('../email-handler', {
    'aws-sdk': { 'S3': MockS3Client },
    '@sendgrid/mail': {
        'send': sendGridStub,
        'setApiKey': setApiKeyStub,
        'setSubstitutionWrappers': setSubstitutionsStub
    }
});

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

describe('*** UNIT TEST SENDGRID EMAIL DISPATCHING FROM REMOTE TEMPLATE ***', () => {

    const testUserName = 'Yesugei';
    const testEmailAddress = 'yesugei@khans.com';
    const validSubject = 'Welcome to Jupiter';

    const validHtmlTemplate = '<p>Greetings {{user}}, \nWelcome to Jupiter.</p>';
    const validTextTemplate = 'Greetings {{user}}. \nWelcome to Jupiter.';

    const testTemplateBucket = 'templateBucket';
    const testTemplateKey = 'templateKey';

    const testDestinationDetails = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
    const validPersonalization = {
        'to': [{ 'email': testEmailAddress }],
        'substitutions': { user: testUserName, subject: validSubject }
    };

    const validAssembledEmail = {
        'from': { 'email': config.get('sendgrid.fromAddress'), 'name': 'Jupiter' },
        'reply_to': { 'email': config.get('sendgrid.replyToAddress'), 'name': 'Jupiter' },
        'subject': '{{subject}}',
        'content': [
            { 'type': 'text/plain', 'value': validTextTemplate },
            { 'type': 'text/html', 'value': validHtmlTemplate }
        ],
        'mail_settings': {
            'sandbox_mode': { 'enable': config.get('sendgrid.sandbox') }
        },
        'personalizations': [validPersonalization]
    };

    const formatError = (errorMessage) => ({ result: 'ERR', message: errorMessage });
     
    beforeEach(() => {
        setApiKeyStub.resolves();
        resetStubs(sendGridStub, getObjectStub);
    });

    it('Handles warm up event', async () => {
        const resultOfEmail = await handler.sendEmailsFromSource({ });
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'Empty invocation' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });
    
    it('Handles single email', async () => {
        const testDestinationArray = [testDestinationDetails];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendGridStub.resolves([{ statusCode: 202, statusMessage: 'Accepted' }]);

        const testEvent = {
            templateKeyBucket: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendGridStub).to.have.been.calledOnceWithExactly(validAssembledEmail);
    });

    it('Handles multiple emails', async () => {
        const expectedAssembledEmail = { ...validAssembledEmail };
        expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization, validPersonalization]; 
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templateKeyBucket: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedAssembledEmail);
    });

    it('Fails on invalid method parameters', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templateKeyBucket: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        Reflect.deleteProperty(testEvent, 'subject');
        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Missing email subject'));

        testEvent.subject = validSubject;

        Reflect.deleteProperty(testEvent, 'templateKeyBucket');
        Reflect.deleteProperty(testEvent, 'textTemplate');

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('At least one template is required'));

        testEvent.textTemplate = validTextTemplate;
        testEvent.templateKeyBucket = { bucket: testTemplateBucket };

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Missing valid template key-bucket pair'));

        testEvent.templateKeyBucket = { key: testTemplateKey, bucket: testTemplateBucket };

        Reflect.deleteProperty(testEvent, 'destinationArray');

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Missing destination array'));

        testEvent.destinationArray = [];
        for (let i = 0; i < 1001; i++) {
            testEvent.destinationArray.push(testDestinationDetails);
        }

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Cannot send to more than 1000 recipients at a time'));

        testEvent.destinationArray = [{}, {}];

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Invalid destination object: {}'));

        testEvent.destinationArray = [{ someOtherKey: 'that should not exist' }];

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError(`Invalid destination object: ${JSON.stringify({someOtherKey: 'that should not exist'})}`));
 
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

    it('Fails on malformed assembled email', async () => {
        const testDestinationArray = [testDestinationDetails];
    
        const testEvent = {
            templateKeyBucket: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => '' }})});

        Reflect.deleteProperty(testEvent, 'textTemplate');

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('You must provide either a text or html template or both'));

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => ({ invalid: 'html template'}) }})});

        testEvent.textTemplate = validTextTemplate;

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError(`Invalid HTML template: ${JSON.stringify({ invalid: 'html template'})}`));

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});

        testEvent.textTemplate = { invalid: 'text template'};

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError(`Invalid text template: ${JSON.stringify({ invalid: 'text template'})}`));

        expect(getObjectStub).to.have.been.calledWith({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendGridStub).to.have.not.been.called;
    });
});

describe('*** UNIT TEST SENDGRID EMAIL DISPATCH FROM LOCAL TEMPLATE ***', () => {

    const testUserName = 'Temujin';
    const testEmailAddress = 'temujin@khans.com';
    const validSubject = 'Welcome to Jupiter';

    const validHtmlTemplate = '<p>Greetings {{user}}, \nWelcome to Jupiter.</p>';
    const validTextTemplate = 'Greetings {{user}}. \nWelcome to Jupiter.';

    const testDestinationDetails = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
    const validPersonalization = {
        'to': [{ 'email': testEmailAddress }],
        'substitutions': { user: testUserName, subject: validSubject }
    };

    const validAssembledEmail = {
        'from': { 'email': config.get('sendgrid.fromAddress'), 'name': 'Jupiter' },
        'reply_to': { 'email': config.get('sendgrid.replyToAddress'), 'name': 'Jupiter' },
        'subject': '{{subject}}',
        'content': [
            { 'type': 'text/plain', 'value': validTextTemplate },
            { 'type': 'text/html', 'value': validHtmlTemplate }
        ],
        'mail_settings': {
            'sandbox_mode': { 'enable': config.get('sendgrid.sandbox') }
        },
        'personalizations': [validPersonalization]
    };

    const formatError = (errorMessage) => ({ result: 'ERR', message: errorMessage });

    beforeEach(() => {
        setApiKeyStub.resolves();
        resetStubs(sendGridStub, getObjectStub);
    });

    it('Handles warm up event', async () => {
        const resultOfEmail = await handler.sendEmails({ });
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'Empty invocation' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });
    
    it('Sends single email', async () => {
        const testDestinationArray = [testDestinationDetails];

        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            htmlTemplate: validHtmlTemplate,
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmails(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.been.calledOnceWithExactly(validAssembledEmail);
    });

    it('Handles multiple emails', async () => {
        const expectedAssembledEmail = { ...validAssembledEmail };
        expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization, validPersonalization]; 
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            htmlTemplate: validHtmlTemplate,
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmails(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedAssembledEmail);
    });

    it('Fails on invalid method parameters', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            htmlTemplate: validHtmlTemplate,
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        Reflect.deleteProperty(testEvent, 'subject');

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('Missing email subject'));

        testEvent.subject = validSubject;

        Reflect.deleteProperty(testEvent, 'htmlTemplate');
        Reflect.deleteProperty(testEvent, 'textTemplate');

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('At least one template is required'));

        testEvent.htmlTemplate = validHtmlTemplate;

        Reflect.deleteProperty(testEvent, 'destinationArray');

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('Missing destination array'));

        testEvent.destinationArray = [];
        for (let i = 0; i < 1001; i++) {
            testEvent.destinationArray.push(testDestinationDetails);
        }
        
        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('Cannot send to more than 1000 recipients at a time'));

        testEvent.destinationArray = [{}, {}];

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('Invalid destination object: {}'));

        testEvent.destinationArray = [{ someOtherKey: 'that should not exist' }];

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError(`Invalid destination object: ${JSON.stringify({someOtherKey: 'that should not exist'})}`));
 
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

    it('Fails on malformed assembled email', async () => {
        const testDestinationArray = [testDestinationDetails];
    
        const testEvent = {
            htmlTemplate: validHtmlTemplate,
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        testEvent.htmlTemplate = { invalid: 'html template' };
        testEvent.textTemplate = validTextTemplate;

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError(`Invalid HTML template: ${JSON.stringify({ invalid: 'html template'})}`));

        testEvent.htmlTemplate = validHtmlTemplate;
        testEvent.textTemplate = { invalid: 'text template'};

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError(`Invalid text template: ${JSON.stringify({ invalid: 'text template'})}`));

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });
});
