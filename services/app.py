from chat import get_response

def chat():
    print("Hello! I am your Symptom Checker Chatbot.")
    print("How can i help you today?")
    print("🤖 Chatbot is ready! (type 'quit' to exit)")
    while True:
        text = input("You: ")
        if text.lower() in ["quit", "exit", "bye"]:
            print("Chatbot: Goodbye!")
            break

        response = get_response(text)
        print("Chatbot:", response)

if __name__ == "__main__":
    chat()


