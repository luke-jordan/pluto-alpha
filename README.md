# POLICIES AND LOCAL DEVELOPMENT

The master branch is protected and will not accept pull requests from any branch aside from staging. 

The staging branch is not protected against pushes but will accept pull requests from development branches. Every PR to staging requires code review 
security and linting to all pass, as well as at least one code review. New branches should fork from the current staging branch. 
Pull requests should aim for 400-500 lines of code at a time to facilitate reviews. Larger PRs will require more reviews before acceptance.

## STEP 1: Quickstart => Install packages, link modules and run tests
Please install Nodejs if you don't have it installed: <https://nodejs.org/en/>.

By the end of this step, you'll be able to run tests for a function or module.
The generic steps involve installing node packages, linking dependent modules and running the tests.
In this example, we'll be using the `functions/float-api` folder as it covers a good use case.
Follow the steps below:


1. Navigate to the root directory of the `pluto-alpha` project. 

2. Install the node packages in the common modules (in this instance: modules `float-api` depends on) by running the command:
 `cd ./modules/rds-common && npm install && sudo npm link && cd ../dynamo-common && npm install && sudo npm link`.
The `npm link` command establishes a linking references for the common modules in step 1, in `./modules/rds-common` and then `./modules/dynamo-common`.
N/B: The above command is contained in the file `link_common_modules.sh` for ease of rerunning when needed.

3. Navigate to the working directory of the dependent function (in this case: `functions/float-api`). Run the command:
`cd ../../functions/float-api`

4. Run `npm install` to install the node modules.
 
5. Link the common modules to `functions/float-api` by running the following command from the terminal:
 `npm link rds-common && npm link dynamo-common`. 
 
6. From the working directory of `functions/float-api`. Run tests with the following command:
`npm run test`

All the tests should be running successfully.


## STEP 2: Getting started with local development
### Step 2a: Docker and Docker Compose 
To install docker and docker-compose, run the following commands:
`sudo apt-get install docker && sudo apt-get install docker-compose`

(Copy in the bits about adding user to group docker)
### Step 2b: Download docker images for Localstack, Postgres and Nodejs Lambda
Run the following commands in the terminal (You can run them concurrently in 3 separate terminals)
`docker pull localstack/localstack:latest`
`docker pull postgres`
`docker pull lambci/lambda:nodejs8.10`

Test that these are all installed correctly by running `docker-compose up` in the root directory of the `pluto-alpha` project..

> Note: You might have to share the folder `/var/folders` in docker's Preferences=>File Sharing to enable `docker-compose up` work effectively.


### Step 2c: Install AWS CLI and AWS-CLI Local:
Ensure you have Python3 installed. If you don't have it installed, visit: <https://www.python.org/downloads/>

Install AWS CLI: <https://aws.amazon.com/cli/>.
Install the AWS-CLI Local wrapper (awslocal): <https://github.com/localstack/awscli-local>.

> Note: If you're having problems installing awslocal, try the command: `pip3 install awslocal`


### Step 2d: Boot your local setup
In the root directory of the `pluto-alpha` project, run `./initiate --noclean`. 
This will launch localstack and the local postgres containers, and it will 
execute the various SQL and CloudFormation templates to set up the persistence layer.

# With the above, you can start development on the application. The steps below are optional and provide more information.

## Core languages (depending on part of stack)

### NodeJS

1.  Install the latest Node and NPM from your favourite package repository
2.  Install the serverless framework:

`sudo npm install -g serverless`


## Install testing frameworks and dependencies

1.  For NodeJS: Mocha and Chai. Suggestion is to install at least Mocha globally, but it can be used locally

`npm install --global mocha`


## Creating Lambdas
For the specific functions use the `create-node-function.sh` script, which will automatically install the necessary
test suite as dev dependencies (Chai, Sinon, Proxyquire). The first argument to the script is the name of the "API", i.e., the 
group of lambdas that relate to a common sub-domain, and the second is the primary function you want to create. 


## Deploying lambdas
The lambdas can then be deployed all at once by running the `deploylambdas` script, or by running `sls deploy --stage local` 
in the lambda folder (for further variants, such as deploying just a single function if the folder contains multiple such 
functions, see the serverless documentation).


## TERRAFORM
After applying terraform:
`terraform workspace select staging`
`terraform apply -var 'deploy_code_commit_hash=058c7f3729dd375e0983e09b276a2a3caa0df3dd' -var 'aws_access_key=****************' -var 'aws_secret_access_key=***********' -var 'db_user=aaabbbccc' -var 'db_password=aaabbbccc'`

API requests can be sent to :
`curl -vvv -X POST  https://[staging|master].jupiterapp.net/verify-jwt`


### Python (for integration testing notebooks etc) => Needed only if you are working on Machine Learning

1.  Download and install Anaconda
2.  Create a new virtual env, using Python 3.6:

`conda create --name pluto-local-dev python=3.6`

3.  Install requirements.txt in templates:

`cd templates; pip install -r ./requirements.txt`

Note: prior to the above you may need to install libpq-dev locally
Note: make sure to install ipython in your virtual env or you will get module import errors all the time

> Note:: If you are running the integration testing notebooks, make sure to add in a pre-commit filter that strips them
of output. See here: https://github.com/toobaz/ipynb_output_filter

### Generating Documentation From Docstrings

Each function directory includes a README file created from the docstrings within the code. To regenenate the README after making changes to the code and related docstrings, install jsdoc2md using the command

```
$ npm install --save-dev jsdoc-to-markdown
```
 then run
 ```
$ jsdoc2md *.js > README.md
```
to generate a README from all the docstrings in the directory. For more information see https://github.com/jsdoc2md/jsdoc-to-markdown
