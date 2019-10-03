resource "aws_sns_topic" "fatal_errors_topic" {
  name = "fatal_errors_topic"
  display_name = "fatal_errors_topic"
}


resource "aws_sns_topic" "security_errors_topic" {
  name = "security_errors_topic"
  display_name = "security_errors_topic"
}

///////////////// FOR EVENT HANDLING (E.G., SAVES, ETC) //////////////
resource "aws_sqs_queue" "user_event_dlq" {
  name = "${terraform.workspace}_user_event_process_dlq"
  tags = {
    environment = "${terraform.workspace}"
  }
}