'use strict';

const logger = require('debug')('jupiter:third-parties:bank-verify-test');
const config = require('config');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const uuidStub = sinon.stub();
const sendgridStub = sinon.stub();
const setApiKeyStub = sinon.stub();
const getObjectStub = sinon.stub();

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub;
    }
}

const handler = proxyquire('../email-handler', {
    'uuid/v4': uuidStub,
    'aws-sdk': { 'S3': MockS3Client },
    '@sendgrid/mail': {
        'send': sendgridStub,
        'setApiKey': setApiKeyStub
    }
});

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

describe('*** UNIT TEST SENDGRID EMAIL DISPATCHING FROM REMOTE TEMPLATE ***', () => {
    const testTemplateId = uuid();

    const testUserName = 'Yesugei';
    const testEmailAddress = 'yesugei@khans.com';
    const testSubject = 'Welcome to Jupiter';

    const testHtmlTemplate = '<p>Greetings {{ user }}, \nWelcome to Jupiter.</p>';
    const testTextTemplate = 'Greetings {{ user }}. \nWelcome to Jupiter.';

    const testTemplateBucket = 'templateBucket';
    const testTemplateKey = 'templateKey';

    beforeEach(() => {
        setApiKeyStub.resolves();
        uuidStub.returns(testTemplateId);
        resetStubs(sendgridStub, getObjectStub);
    });
    
    it('Sends email to user', async () => {

        const expectedEmail = {
            'dynamic_template_data': { user: testUserName },
            'from': config.get('sendgrid.sourceAddress'),
            'html': testHtmlTemplate,
            'mail_settings': {
                'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
            },
            'subject': testSubject,
            'template_id': testTemplateId,
            'text': testTextTemplate,
            'to': testEmailAddress
        };

        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => testHtmlTemplate }})});
        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromSource(testEvent);
        logger('Result of email:', resultOfEmail);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendgridStub).to.have.been.calledOnceWithExactly(expectedEmail);
    });

    it('Handles multiple emails', async () => {

        const expectedEmail = {
            'dynamic_template_data': { user: testUserName },
            'from': config.get('sendgrid.sourceAddress'),
            'html': testHtmlTemplate,
            'mail_settings': {
                'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
            },
            'subject': testSubject,
            'template_id': testTemplateId,
            'text': testTextTemplate,
            'to': testEmailAddress
        };

        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData, testDestinationData, testDestinationData];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => testHtmlTemplate }})});
        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromSource(testEvent);
        logger('Result of email:', resultOfEmail);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendgridStub).to.have.been.calledThrice;
        expect(sendgridStub).to.have.been.calledWith(expectedEmail);
    });

    it('Failure of one email does not domino onto others', async () => {

        const expectedEmail = {
            'dynamic_template_data': { user: testUserName },
            'from': config.get('sendgrid.sourceAddress'),
            'html': testHtmlTemplate,
            'mail_settings': {
                'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
            },
            subject: testSubject,
            'template_id': testTemplateId,
            'text': testTextTemplate,
            'to': testEmailAddress
        };

        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData, testDestinationData, testDestinationData];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => testHtmlTemplate }})});
        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);
        sendgridStub.onSecondCall().throws(new Error('Bad Request'));

        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromSource(testEvent);
        logger('Result of email:', resultOfEmail);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendgridStub).to.have.been.calledThrice;
        expect(sendgridStub).to.have.been.calledWith(expectedEmail);
    });

    it('Fails on invalid parameters', async () => {
        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData, testDestinationData, testDestinationData];

        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        Reflect.deleteProperty(testEvent, 'subject');
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith('Missing email subject');

        testEvent.subject = testSubject;
        Reflect.deleteProperty(testEvent, 'templateSource');
        Reflect.deleteProperty(testEvent, 'textTemplate');
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith('At least one template is required');

        testEvent.textTemplate = testTextTemplate;
        testEvent.templateSource = { bucket: testTemplateBucket };
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith('Missing valid template key-bucket pair');

        testEvent.templateSource = { key: testTemplateKey, bucket: testTemplateBucket };
        Reflect.deleteProperty(testEvent, 'destinationArray');
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith('Missing destination array');

        testEvent.destinationArray = [{}, {}];
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith('Invalid destination object: {}');

        testEvent.destinationArray = [{ someOtherKey: 'that should not exist' }];
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith(`Invalid destination object: ${JSON.stringify({someOtherKey: 'that should not exist'})}`);
 
        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.not.been.called;
    });

    it('Fails on malformed email', async () => {
        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData];
    
        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => testHtmlTemplate }})});
        uuidStub.returns();
        testEvent.textTemplate = testTextTemplate;
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith();

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => '' }})});
        uuidStub.returns(testTemplateId);
        Reflect.deleteProperty(testEvent, 'textTemplate');
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith('You must provide either a text or html template or both');

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => ({ invalid: 'html template'}) }})});
        testEvent.textTemplate = testTextTemplate;
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith(`Invalid HTML template: ${JSON.stringify({ invalid: 'html template'})}`);

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => testHtmlTemplate }})});
        testEvent.textTemplate = { invalid: 'text template'};
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith(`Invalid text template: ${JSON.stringify({ invalid: 'text template'})}`);

        expect(getObjectStub).to.have.been.calledWith({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendgridStub).to.have.not.been.called;
    });
});

describe('*** UNIT TEST SENDGRID EMAIL DISPATCH FROM LOCAL TEMPLATE ***', () => {
    const testTemplateId = uuid();

    const testUserName = 'Temujin';
    const testEmailAddress = 'yesugei@khans.com';
    const testSubject = 'Welcome to Jupiter';

    const testHtmlTemplate = '<p>Greetings {{ user }}, \nWelcome to Jupiter.</p>';
    const testTextTemplate = 'Greetings {{ user }}. \nWelcome to Jupiter.';

    beforeEach(() => {
        setApiKeyStub.resolves();
        uuidStub.returns(testTemplateId);
        resetStubs(sendgridStub, getObjectStub);
    });
    
    it('Sends email to user', async () => {

        const expectedEmail = {
            'dynamic_template_data': { user: testUserName },
            'from': config.get('sendgrid.sourceAddress'),
            'html': testHtmlTemplate,
            'mail_settings': {
                'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
            },
            'subject': testSubject,
            'template_id': testTemplateId,
            'text': testTextTemplate,
            'to': testEmailAddress
        };

        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData];

        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            htmlTemplate: testHtmlTemplate,
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromTemplate(testEvent);
        logger('Result of email:', resultOfEmail);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.been.calledOnceWithExactly(expectedEmail);
    });

    it('Handles multiple emails', async () => {

        const expectedEmail = {
            'dynamic_template_data': { user: testUserName },
            'from': config.get('sendgrid.sourceAddress'),
            'html': testHtmlTemplate,
            'mail_settings': {
                'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
            },
            'subject': testSubject,
            'template_id': testTemplateId,
            'text': testTextTemplate,
            'to': testEmailAddress
        };

        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData, testDestinationData, testDestinationData];

        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            htmlTemplate: testHtmlTemplate,
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromTemplate(testEvent);
        logger('Result of email:', resultOfEmail);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.been.calledThrice;
        expect(sendgridStub).to.have.been.calledWith(expectedEmail);
    });

    it('Failure of one email does not domino onto others', async () => {

        const expectedEmail = {
            'dynamic_template_data': { user: testUserName },
            'from': config.get('sendgrid.sourceAddress'),
            'html': testHtmlTemplate,
            'mail_settings': {
                'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
            },
            'subject': testSubject,
            'template_id': testTemplateId,
            'text': testTextTemplate,
            'to': testEmailAddress
        };

        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData, testDestinationData, testDestinationData];

        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);
        sendgridStub.onSecondCall().throws(new Error('Bad Request'));

        const testEvent = {
            htmlTemplate: testHtmlTemplate,
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromTemplate(testEvent);
        logger('Result of email:', resultOfEmail);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.been.calledThrice;
        expect(sendgridStub).to.have.been.calledWith(expectedEmail);
    });

    it('Fails on invalid parameters', async () => {
        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData, testDestinationData, testDestinationData];

        const testEvent = {
            htmlTemplate: testHtmlTemplate,
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        Reflect.deleteProperty(testEvent, 'subject');
        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('Missing email subject');

        testEvent.subject = testSubject;
        Reflect.deleteProperty(testEvent, 'htmlTemplate');
        Reflect.deleteProperty(testEvent, 'textTemplate');
        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('At least one template is required');

        testEvent.htmlTemplate = testHtmlTemplate;
        Reflect.deleteProperty(testEvent, 'destinationArray');
        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('Missing destination array');

        testEvent.destinationArray = [{}, {}];
        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('Invalid destination object: {}');

        testEvent.destinationArray = [{ someOtherKey: 'that should not exist' }];
        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith(`Invalid destination object: ${JSON.stringify({someOtherKey: 'that should not exist'})}`);
 
        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.not.been.called;
    });

    it('Fails on malformed email', async () => {
        const testDestinationData = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
        const testDestinationArray = [testDestinationData];
    
        const testEvent = {
            htmlTemplate: testHtmlTemplate,
            textTemplate: testTextTemplate,
            subject: testSubject,
            destinationArray: testDestinationArray
        };

        uuidStub.returns();
        testEvent.textTemplate = testTextTemplate;
        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('Missing or invalid template id');

        uuidStub.returns(testTemplateId);
        testEvent.htmlTemplate = { invalid: 'html template' };
        testEvent.textTemplate = testTextTemplate;
        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith(`Invalid HTML template: ${JSON.stringify({ invalid: 'html template'})}`);

        testEvent.htmlTemplate = testHtmlTemplate;
        testEvent.textTemplate = { invalid: 'text template'};
        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith(`Invalid text template: ${JSON.stringify({ invalid: 'text template'})}`);

        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.not.been.called;
    });
});
