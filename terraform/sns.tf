resource "aws_sns_topic" "fatal_errors_topic" {
  name = "fatal_errors_topic"
  display_name = "fatal_errors_topic"
}


resource "aws_sns_topic" "security_errors_topic" {
  name = "security_errors_topic"
  display_name = "security_errors_topic"
}