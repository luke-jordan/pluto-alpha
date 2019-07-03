# POLICIES AND LOCAL DEVELOPMENT

The master branch is protected and will not accept pull requests from any branch aside from staging. The staging 
branch is protected against pushes but will accept pull requests from development branches. Every PR to staging requires code review 
security and linting to all pass, as well as at least one code review. New branches should fork from the current staging branch. 
Pull requests should aim for 400-500 lines of code at a time to facilitate reviews. Larger PRs will require more reviews before acceptance.

For local development, you need to install:

1.   Docker (along with docker-compose)
2.   Localstack
3.   Postgres
4.   The core languages, Python and Nodejs
5.   Set up a virtual env
6.   The core testing frameworks

These have been grouped together below.

## STEP 1: Docker and LocalStack

`sudo apt-get install docker`
`sudo apt-get instlal docker-compose`

(Copy in the bits about adding user to group docker)

`docker pull localstack/localstack:latest`
`docker pull postgres`
`docker pull lambci/lambda:nodejs8.10`

Test that these are all installed correctly by running `docker-compose up` in the root folder.

**Note** If you do not already have the AWS CLI installed, then install it as here: <https://aws.amazon.com/cli/>. If you
do not have Python yet, install it as below. It is also suggested that you install the AWS Local wrapper, here: 
<https://github.com/localstack/awscli-local>. The shortcut is just run `pip install awslocal`.

## STEP 2: Core languages (depending on part of stack)

### NodeJS

1.  Install the latest Node and NPM from your favourite package repository
2.  Install the serverless framework:

`sudo npm install -g serverless`

### Python (optional at present)

1.  Downloand and install Anaconda
2.  Create a new virtual env, using Python 3.6:

`conda create --name pluto-local-dev python=3.6`

3.  Install requirements.txt in templates:

`cd templates; pip install -r ./requirements.txt`

Note: prior to the above you may need to install libpq-dev locally
Note: make sure to install ipython in your virtual env or you will get module import errors all the time

## STEP 3: Install testing frameworks and dependencies

1.  For NodeJS: Mocha and Chai. Suggestion is to install at least Mocha globally, but it can be used locally

`npm install --global mocha`

2.  For the specific functions use the `create-node-function.sh` script, which will automatically install the necessary
test suite as dev dependencies (Chai, Sinon, Proxyquire). The first argument to the script is the name of the "API", i.e., the 
group of lambdas that relate to a common sub-domain, and the second is the primary function you want to create. 

## STEP 4: Install packages and link modules

1.  Install the node packages in the common modules by going to `./modules/rds-common` and `./modules/dynamo-common` and running
`npm install` (all at once or as they are deployed).

2.  Establish linking references for those two modules by, in each folder, running the command (you will probably need to sudo):

``npm link``

3.  In the dependent functions, link the modules by entering `npm link rds-common` and `npm link dynamo-common`. Do this all at
once or only for those that are working with / deploying locally.

## STEP 5: Check it's working

In the root folder run `./initiate --no-clean`. That will launch localstack and the local postgres containers, and it will 
execute the various SQL and CloudFormation templates to set up the persistence layer.

The lambdas can then be deployed all at once by running the `deploylambdas` script, or by running `sls deploy --stage local` 
in the lambda folder (for further variants, such as deploying just a single function if the folder contains multiple such 
functions, see the serverless documentation).

## TERRAFORM
After applying terraform:
`terraform workspace select staging`
`terraform apply -var 'deploy_code_commit_hash=058c7f3729dd375e0983e09b276a2a3caa0df3dd' -var 'aws_access_key=****************' -var 'aws_secret_access_key=***********' -var 'db_user=aaabbbccc' -var 'db_password=aaabbbccc'`

API requests can be sent to :
`curl -vvv -X POST  https://[staging|master].jupiterapp.net/verify-jwt`