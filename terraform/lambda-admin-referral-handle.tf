variable "admin_referral_handle_lambda_function_name" {
  default = "admin_referral_handle"
  type = "string"
}

resource "aws_lambda_function" "admin_referral_handle" {

  function_name                  = "${var.admin_referral_handle_lambda_function_name}"
  role                           = "${aws_iam_role.admin_referral_handle_role.arn}"
  handler                        = "admin-refs-handler.manageReferralCodes"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 30
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "admin_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                  "region": "${var.aws_default_region[terraform.workspace]}"
              }
          }
      )}"
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.admin_referral_handle,
    aws_iam_role_policy_attachment.admin_referral_handle_basic_execution_policy,
    aws_iam_role_policy_attachment.admin_referral_handle_client_float_access,
    aws_iam_role_policy_attachment.admin_referral_handle_omnibus_access
  ]
}

resource "aws_iam_role" "admin_referral_handle_role" {
  name = "${var.admin_referral_handle_lambda_function_name}_role_${terraform.workspace}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

resource "aws_cloudwatch_log_group" "admin_referral_handle" {
  name = "/aws/lambda/${var.admin_referral_handle_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "admin_referral_handle_basic_execution_policy" {
  role = "${aws_iam_role.admin_referral_handle_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_referral_handle_client_float_access" {
  role = "${aws_iam_role.admin_referral_handle_role.name}"
  policy_arn = aws_iam_policy.admin_client_float_access.arn
}

resource "aws_iam_role_policy_attachment" "admin_referral_handle_omnibus_access" {
  role = "${aws_iam_role.admin_referral_handle_role.name}"
  policy_arn = aws_iam_policy.referral_management_omnibus_policy.arn
}
