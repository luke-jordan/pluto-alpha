# GETTING STARTED: SETTING UP THE LOCAL ENVIRONMENT

For local development, you need to install:

1.  Docker (along with docker-compose)
2.  Localstack
3.  Postgres
4.  The core languages, Python and Nodejs
5.  Set up a virtual env
6.  The core testing frameworks

These have been grouped together below.

## STEP 1: Docker and LocalStack

`sudo apt-get install docker`
`sudo apt-get instlal docker-compose`

(Copy in the bits about adding user to group docker)

`docker pull localstack/localstack:latest`
`docker pull postgres`
`docker pull lambci/lambda:nodejs8.10`

Test that these are all installed correctly by running `docker-compose up` in the root folder.

## STEP 2: Core languages (depending on part of stack)

### Python

1. Downloand and install Anaconda
2. Create a new virtual env, using Python 3.6:

`conda create --python36 ua-local-dev`

3. Install requirements.txt in templates:

`cd templates; pip install -r ./requirements.txt`

Note: prior to the above you may need to install libpq-dev locally
Note: make sure to install ipython in your virtual env or you will get module import errors all the time

### NodeJS

1. Install the latest Node and NPM from repository
2. Install the serverless framework:

`sudo npm install -g serverless`

3. Unless bug fixed by then - install our, patched version of serverless-localstack

`git pull ...`
`npm link ...`

## STEP 3: Testing frameworks

1. For NodeJS: Mocha and Chai, globals

## STEP 4: Link modules

npm link

## STEP 5: Check it's working

In the root folder run ./initiate