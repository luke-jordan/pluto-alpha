#! /bin/bash

echo "Deploying the float lambda"
cd functions/float-api
serverless deploy --stage local

echo "Deploying the user account mgmt lambda"
cd ../account-api
serverless deploy --stage local

echo "Deploying the save transaction lambda"
cd ../save-transaction-api
serverless deploy --stage local