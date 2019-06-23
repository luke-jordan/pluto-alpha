
variable "aws_iam_role_name" {
  type = "string"
}

resource "aws_iam_role_policy_attachment" "basic_execution_policy" {
  role = "${var.aws_iam_role_name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}