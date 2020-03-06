'use strict';

const config = require('config');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire');

const getSecretStub = sinon.stub();

const poolConstructorStub = sinon.stub();

const connectStub = sinon.stub();
const endStub = sinon.stub();

class MockSecretsManager {
    constructor () {
        this.getSecretValue = getSecretStub;
    }
}

const obtainFreshConnection = () => {
    const RdsConnection = proxyquire('../index', {
        'pg': { Pool: poolConstructorStub },
        'aws-sdk': { 'SecretsManager': MockSecretsManager },
        '@noCallThru': true
    });
    
    return new RdsConnection(config.get('db'), { enabled: true });
};

describe('*** UNIT TEST BASIC POOL MGMT ***', () => {
    
    let rdsClient = { };

    beforeEach(() => {
        poolConstructorStub.reset();
        poolConstructorStub.returns({ connect: connectStub, end: endStub });

        connectStub.reset();
        getSecretStub.reset();
    });

    it('Fetches secret and initializes', async () => {
        const mockSecret = { username: 'jupiter-secret-user', password: 'jupiter-password' };
        getSecretStub.yields(false, { SecretString: JSON.stringify(mockSecret) });
        connectStub.returns('Connection established');

        rdsClient = obtainFreshConnection();
        const connection = await rdsClient._getConnection(10, 50);
        expect(connection).to.deep.equal('Connection established');
        expect(getSecretStub).to.have.been.calledOnceWith({ SecretId: 'somesecret' });
    });

    it('Retries secret on first failure, succeeds on second', async () => {
        const mockSecret = { username: 'jupiter-secret-user', password: 'jupiter-password' };
        getSecretStub.onFirstCall().yields(Error('Connection time exceeded'), null);
        getSecretStub.onSecondCall().yields(false, { SecretString: JSON.stringify(mockSecret) });
        connectStub.returns('Connection established');

        rdsClient = obtainFreshConnection();
        const connection = await rdsClient._getConnection(10, 50);
        expect(connection).to.deep.equal('Connection established');
        expect(getSecretStub).to.have.been.calledTwice;
        // expect(getSecretStub).to.have.been.calledWith({ SecretId: 'somesecret' });        
    });

    it('Retries if prior cached credentials are invalid', async () => {
        const mockOldSecret = { username: 'jupiter-secret-user', password: 'jupiter-password' };
        const mockNewSecret = { username: 'jupiter-secret-user-clone', password: 'jupiter-password-rotated' };

        getSecretStub.onFirstCall().yields(false, { SecretString: JSON.stringify(mockOldSecret) });
        poolConstructorStub.onFirstCall().throws('Invalid credentials!');
        
        getSecretStub.onSecondCall().yields(false, { SecretString: JSON.stringify(mockNewSecret) });
        poolConstructorStub.onSecondCall().returns({ connect: connectStub, end: endStub });
        
        connectStub.returns('Connection established');

        rdsClient = obtainFreshConnection();
        const connection = await rdsClient._getConnection(10);
        expect(connection).to.deep.equal('Connection established');
        expect(getSecretStub).to.have.been.calledTwice;
    });

    it('Does not call again if cached values are present', async () => {
        const mockSecret = { username: 'jupiter-secret-user', password: 'jupiter-password' };
        getSecretStub.yields(false, { SecretString: JSON.stringify(mockSecret) });
        connectStub.returns('Connection established');

        const RdsConnection = proxyquire('../index', {
            'pg': { Pool: poolConstructorStub },
            'aws-sdk': { 'SecretsManager': MockSecretsManager },
            '@noCallThru': true
        });
        
        const firstClient = new RdsConnection(config.get('db'), { enabled: true });
        const connection = await firstClient._getConnection(10, 50);
        
        expect(connection).to.deep.equal('Connection established');

        const secondClient = new RdsConnection(config.get('db'), { enabled: true });

        const secondConnect = await secondClient._getConnection(10, 50);
        expect(secondConnect).to.deep.equal('Connection established');
        
        // two connections, one call, hence
        expect(getSecretStub).to.have.been.calledOnceWith({ SecretId: 'somesecret' });
    });

});
