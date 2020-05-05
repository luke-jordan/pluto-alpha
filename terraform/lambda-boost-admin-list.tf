variable "boost_admin_list_lambda_function_name" {
  default = "boost_admin_list"
  type = "string"
}

resource "aws_lambda_function" "boost_admin_list" {

  function_name                  = "${var.boost_admin_list_lambda_function_name}"
  role                           = "${aws_iam_role.boost_admin_list_role.arn}"
  handler                        = "boost-admin-handler.listBoosts"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 15
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "boost_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                "region": "${var.aws_default_region[terraform.workspace]}"
              },
              "db": {
                "host": "${local.database_config.host}",
                "database": "${local.database_config.database}",
                "port" :"${local.database_config.port}"
              },
              "secrets": {
                "enabled": true,
                "names": {
                    "boost_worker": "${terraform.workspace}/ops/psql/boost"
                }
              }
          }
      )}"
    }
  }
  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.boost_admin_list]
}

resource "aws_iam_role" "boost_admin_list_role" {
  name = "${var.boost_admin_list_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "boost_admin_list" {
  name = "/aws/lambda/${var.boost_admin_list_lambda_function_name}"
  retention_in_days = 3

  tags = {
    environment = "${terraform.workspace}"
  }
}

resource "aws_iam_role_policy_attachment" "boost_admin_list_basic_execution_policy" {
  role = "${aws_iam_role.boost_admin_list_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "boost_admin_list_vpc_execution_policy" {
  role = "${aws_iam_role.boost_admin_list_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "boost_admin_list_secret_get" {
  role = "${aws_iam_role.boost_admin_list_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_boost_worker_read"
}
