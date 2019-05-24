#! /bin/bash

echo "Deploying the float lambda"
cd ../functions/float-api
serverless deploy --stage local

echo "Deploying the user account mgmt lambda"
cd ../user-existence-api
serverless deploy --stage local

echo "Deploying the save transaction lambda"
cd ../user-act-api
serverless deploy --stage local
