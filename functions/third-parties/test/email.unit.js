'use strict';

// const logger = require('debug')('jupiter:third-parties:sendgrid-unit-test');
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
    const validSubject = 'Welcome to Jupiter';

    const validHtmlTemplate = '<p>Greetings {{ user }}, \nWelcome to Jupiter.</p>';
    const validTextTemplate = 'Greetings {{ user }}. \nWelcome to Jupiter.';

    const testTemplateBucket = 'templateBucket';
    const testTemplateKey = 'templateKey';

    const testDestinationDetails = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
    
    const validAssembledEmail = {
        'dynamic_template_data': { user: testUserName },
        'from': config.get('sendgrid.sourceAddress'),
        'html': validHtmlTemplate,
        'mail_settings': {
            'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
        },
        'subject': validSubject,
        'template_id': testTemplateId,
        'text': validTextTemplate,
        'to': testEmailAddress
    };
    
    beforeEach(() => {
        setApiKeyStub.resolves();
        uuidStub.returns(testTemplateId);
        resetStubs(sendgridStub, getObjectStub);
    });
    
    it('Handles single email', async () => {
        const testDestinationArray = [testDestinationDetails];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromSource(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendgridStub).to.have.been.calledOnceWithExactly(validAssembledEmail);
    });

    it('Handles multiple emails', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromSource(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendgridStub).to.have.been.calledThrice;
        expect(sendgridStub).to.have.been.calledWith(validAssembledEmail);
    });

    it('Failure of one email does not domino onto others', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);
        sendgridStub.onSecondCall().throws(new Error('Bad Request'));

        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromSource(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendgridStub).to.have.been.calledThrice;
        expect(sendgridStub).to.have.been.calledWith(validAssembledEmail);
    });

    it('Fails on invalid method parameters', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        Reflect.deleteProperty(testEvent, 'subject');
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith('Missing email subject');

        testEvent.subject = validSubject;

        Reflect.deleteProperty(testEvent, 'templateSource');
        Reflect.deleteProperty(testEvent, 'textTemplate');

        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith('At least one template is required');

        testEvent.textTemplate = validTextTemplate;
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

    it('Fails on malformed assembled email', async () => {
        const testDestinationArray = [testDestinationDetails];
    
        const testEvent = {
            templateSource: { key: testTemplateKey, bucket: testTemplateBucket },
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        uuidStub.returns();

        testEvent.textTemplate = validTextTemplate;
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith();

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => '' }})});
        uuidStub.returns(testTemplateId);

        Reflect.deleteProperty(testEvent, 'textTemplate');
        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith('You must provide either a text or html template or both');

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => ({ invalid: 'html template'}) }})});

        testEvent.textTemplate = validTextTemplate;

        await expect(handler.publishFromSource(testEvent)).to.be.rejectedWith(`Invalid HTML template: ${JSON.stringify({ invalid: 'html template'})}`);

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});

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
    const validSubject = 'Welcome to Jupiter';

    const validHtmlTemplate = '<p>Greetings {{ user }}, \nWelcome to Jupiter.</p>';
    const validTextTemplate = 'Greetings {{ user }}. \nWelcome to Jupiter.';

    const testDestinationDetails = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};

    const validAssembledEmail = {
        'dynamic_template_data': { user: testUserName },
        'from': config.get('sendgrid.sourceAddress'),
        'html': validHtmlTemplate,
        'mail_settings': {
            'sandbox_mode': { enable: config.get('sendgrid.sandbox') }
        },
        'subject': validSubject,
        'template_id': testTemplateId,
        'text': validTextTemplate,
        'to': testEmailAddress
    };

    beforeEach(() => {
        setApiKeyStub.resolves();
        uuidStub.returns(testTemplateId);
        resetStubs(sendgridStub, getObjectStub);
    });
    
    it('Sends single email', async () => {
        const testDestinationArray = [testDestinationDetails];

        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            htmlTemplate: validHtmlTemplate,
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromTemplate(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.been.calledOnceWithExactly(validAssembledEmail);
    });

    it('Handles multiple emails', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            htmlTemplate: validHtmlTemplate,
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromTemplate(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.been.calledThrice;
        expect(sendgridStub).to.have.been.calledWith(validAssembledEmail);
    });

    it('Failure of one email does not domino onto others', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        sendgridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);
        sendgridStub.onSecondCall().throws(new Error('Bad Request'));

        const testEvent = {
            htmlTemplate: validHtmlTemplate,
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.publishFromTemplate(testEvent);
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.been.calledThrice;
        expect(sendgridStub).to.have.been.calledWith(validAssembledEmail);
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

        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('Missing email subject');

        testEvent.subject = validSubject;

        Reflect.deleteProperty(testEvent, 'htmlTemplate');
        Reflect.deleteProperty(testEvent, 'textTemplate');

        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('At least one template is required');

        testEvent.htmlTemplate = validHtmlTemplate;

        Reflect.deleteProperty(testEvent, 'destinationArray');

        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('Missing destination array');

        testEvent.destinationArray = [{}, {}];

        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('Invalid destination object: {}');

        testEvent.destinationArray = [{ someOtherKey: 'that should not exist' }];

        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith(`Invalid destination object: ${JSON.stringify({someOtherKey: 'that should not exist'})}`);
 
        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.not.been.called;
    });

    it('Fails on malformed assembled email', async () => {
        const testDestinationArray = [testDestinationDetails];
    
        const testEvent = {
            htmlTemplate: validHtmlTemplate,
            textTemplate: validTextTemplate,
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        uuidStub.returns();

        testEvent.textTemplate = validTextTemplate;

        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith('Missing or invalid template id');

        uuidStub.returns(testTemplateId);

        testEvent.htmlTemplate = { invalid: 'html template' };
        testEvent.textTemplate = validTextTemplate;

        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith(`Invalid HTML template: ${JSON.stringify({ invalid: 'html template'})}`);

        testEvent.htmlTemplate = validHtmlTemplate;
        testEvent.textTemplate = { invalid: 'text template'};

        await expect(handler.publishFromTemplate(testEvent)).to.be.rejectedWith(`Invalid text template: ${JSON.stringify({ invalid: 'text template'})}`);

        expect(getObjectStub).to.have.not.been.called;
        expect(sendgridStub).to.have.not.been.called;
    });
});
