import { Input, FormControl, FormLabel, InputGroup, InputLeftElement, FormErrorMessage, Icon } from "@chakra-ui/react";
import { FiFile } from "react-icons/fi";
import { useRef, useState } from "react";

export const FileUpload = ({ name, placeholder, acceptedFileTypes, control,showfile, children, isRequired = false }) => {
	const inputRef = useRef();
	const [value,setValue] = useState('');
	var invalid = false
	const onChangefun =(e) =>{
		e.preventDefault();
		showfile(e)
		// console.log(e.target.files[0]);
		setValue(e.target.files[0].name)
	}
	return (
		<FormControl isRequired>
			<FormLabel htmlFor="writeUpFile">{children}</FormLabel>
			<InputGroup>
				<InputLeftElement
					pointerEvents="none">
					<Icon as={FiFile} />
				</InputLeftElement>
				<input type='file'
					   onChange={onChangefun}
					   accept={acceptedFileTypes}
					   name={name}
					   ref={inputRef}
					   style={{display: 'none'}} />
				<Input
					placeholder={placeholder || "Your file ..."}
					onClick={() => inputRef.current.click()}
					// onChange={(e) => {}}
					readOnly={true}
					value={value}
				/>
			</InputGroup>
			<FormErrorMessage>
				{invalid}
			</FormErrorMessage>
		</FormControl>
	);
}

FileUpload.defaultProps = {
	acceptedFileTypes: '',
	allowMultipleFiles: false,
};

export default FileUpload;