#!/bin/bash

terraform init
terraform workspace select $CIRCLE_BRANCH

terraform plan -var "deploy_code_commit_hash=$CIRCLE_SHA1" -var "aws_access_key=$AWS_ACCESS_KEY_ID" -var "aws_secret_access_key=$AWS_SECRET_ACCESS_KEY" -var "db_user=$RDS_USERNAME" -var "db_password=$RDS_PASSWORD"
terraform apply -auto-approve -var "deploy_code_commit_hash=$CIRCLE_SHA1" -var "aws_access_key=$AWS_ACCESS_KEY_ID" -var "aws_secret_access_key=$AWS_SECRET_ACCESS_KEY" -var "db_user=$RDS_USERNAME" -var "db_password=$RDS_PASSWORD"

if [ $CIRCLE_BRANCH == 'master' ]; then
    migrator_region=eu-west-1
fi

if [ $CIRCLE_BRANCH == 'staging' ]; then
    migrator_region=us-east-1
fi

/home/circleci/bin/aws lambda invoke --region $migrator_region --invocation-type RequestResponse --function-name db_migration --payload file://$HOME/app/functions/db-migration/create_roles_event.json  --log-type Tail -
/home/circleci/bin/aws lambda invoke --region $migrator_region --invocation-type RequestResponse --function-name db_migration --payload '{"type": "SETUP_TABLES"}' --log-type Tail -
