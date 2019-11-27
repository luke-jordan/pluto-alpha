variable "admin_comparators_edit_lambda_function_name" {
  default = "admin_comparators_edit"
  type = "string"
}

resource "aws_lambda_function" "admin_comparators_edit" {

  function_name                  = "${var.admin_comparators_edit_lambda_function_name}"
  role                           = "${aws_iam_role.admin_comparators_edit_role.arn}"
  handler                        = "admin-refs-handler.setFloatReferenceRates"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 15
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

  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.admin_comparators_edit]
}

resource "aws_iam_role" "admin_comparators_edit_role" {
  name = "${var.admin_comparators_edit_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "admin_comparators_edit" {
  name = "/aws/lambda/${var.admin_comparators_edit_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "admin_comparators_edit_basic_execution_policy" {
  role = "${aws_iam_role.admin_comparators_edit_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_comparators_edit_vpc_execution_policy" {
  role = "${aws_iam_role.admin_comparators_edit_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_comparators_edit_table_access" {
  role = "${aws_iam_role.admin_comparators_edit_role.name}"
  policy_arn = "${aws_iam_policy.admin_client_float_access.arn}"
}
